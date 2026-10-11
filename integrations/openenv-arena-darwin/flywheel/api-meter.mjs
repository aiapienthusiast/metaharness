// Local metering proxy for paid LLM APIs (Anthropic, OpenAI) with a fail-closed spend cap.
//
//   API_METER_TOKEN=<local token> ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node api-meter.mjs --cap-usd 150 [--port 4010]
//
// Clients call http://127.0.0.1:PORT/anthropic/... or /openai/... with the LOCAL token (x-api-key or Authorization: Bearer).
// The real provider keys exist only in this process's environment; clients never see them. Every response's usage is
// priced and appended to a ledger; once spent + in-flight reservations + the next request's worst case would pass the
// cap, requests get HTTP 402 and nothing is forwarded. Prices below are deliberately HIGH (overestimates) so the meter
// trips before the real bill does. A response without usage is charged its full reservation.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const UPSTREAM = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com' };
const M = 1_000_000;

/** USD per million tokens {in, out}; overestimates. */
export function priceFor(provider, model = '') {
  const m = String(model).toLowerCase();
  if (provider === 'anthropic') {
    if (m.includes('haiku')) return { in: 1.5, out: 7.5 };
    if (m.includes('sonnet')) return { in: 5, out: 25 };
    return { in: 15, out: 75 }; // opus, fable and anything unknown
  }
  if (/nano/.test(m)) return { in: 0.3, out: 1.2 };
  if (/mini/.test(m)) return { in: 1.5, out: 6 };
  if (/^(gpt-5|o3|o1|gpt-4\.1|gpt-4o|codex)/.test(m)) return { in: 3, out: 15 };
  return { in: 5, out: 25 };
}

/** Cost of one response's usage object (Anthropic or OpenAI chat/responses shapes). */
export function costOf(provider, model, usage) {
  if (!usage || typeof usage !== 'object') return null;
  const p = priceFor(provider, model);
  const n = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  if (provider === 'anthropic') {
    const inp = n(usage.input_tokens), out = n(usage.output_tokens), cw = n(usage.cache_creation_input_tokens), cr = n(usage.cache_read_input_tokens);
    if (!inp && !out && !cw && !cr) return null;
    return (inp * p.in + cw * p.in * 1.25 + cr * p.in * 0.1 + out * p.out) / M;
  }
  const prompt = n(usage.prompt_tokens ?? usage.input_tokens), out = n(usage.completion_tokens ?? usage.output_tokens);
  const cached = n(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens);
  if (!prompt && !out) return null;
  return (Math.max(0, prompt - cached) * p.in + cached * p.in * 0.5 + out * p.out) / M;
}

/** Worst case of one request before it runs: input estimated from the body size, output from the declared limit. */
export function reservationFor(provider, model, bodyBytes, body) {
  const p = priceFor(provider, model);
  const maxOut = Number(body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens) || 8192;
  return (Math.ceil(bodyBytes / 3) * p.in + maxOut * p.out) / M;
}

/** Pull the usage object out of one SSE data payload (Anthropic message_start/message_delta, OpenAI chunk or response.completed). */
export function usageFromEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'message_start') return { kind: 'start', usage: obj.message?.usage, model: obj.message?.model };
  if (obj.type === 'message_delta') return { kind: 'delta', usage: obj.usage };
  if (obj.response?.usage) return { kind: 'final', usage: obj.response.usage, model: obj.response.model };
  if (obj.usage && typeof obj.usage === 'object') return { kind: 'final', usage: obj.usage, model: obj.model };
  return null;
}

function loadSpent(ledger) {
  if (!existsSync(ledger)) return 0;
  let s = 0;
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { throw new Error('api-meter: malformed ledger row; refusing to start'); }
    if (!(Number.isFinite(j.usd) && j.usd >= 0)) throw new Error('api-meter: bad usd in ledger; refusing to start');
    s += j.usd;
  }
  return s;
}

export function createMeter({ capUsd, ledger, fetchImpl = globalThis.fetch, upstream = UPSTREAM, keys = {}, token, log = () => {} }) {
  if (!(Number.isFinite(capUsd) && capUsd > 0)) throw new Error('api-meter: capUsd must be a finite number > 0');
  if (!token || token.length < 16) throw new Error('api-meter: a local token of at least 16 characters is required');
  mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  const state = { spent: loadSpent(ledger), reserved: 0 };
  const record = (row) => { state.spent += row.usd; appendFileSync(ledger, `${JSON.stringify({ v: 1, ts: new Date().toISOString(), ...row, cumulative: +state.spent.toFixed(6) })}\n`); };

  async function handle(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/meter') return send(200, { spent: +state.spent.toFixed(4), reserved: +state.reserved.toFixed(4), cap: capUsd });
    const m = /^\/(anthropic|openai)(\/.*)$/.exec(url.pathname);
    if (!m) return send(404, { error: { type: 'not_found', message: 'use /anthropic/... or /openai/...' } });
    const [, provider, rest] = m;
    const given = req.headers['x-api-key'] ?? (String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    if (given !== token) return send(401, { error: { type: 'unauthorized' } });
    if (!keys[provider]) return send(503, { error: { type: 'no_key', message: `no ${provider} key loaded` } });
    const chunks = []; for await (const c of req) chunks.push(c);
    let raw = Buffer.concat(chunks), body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* not JSON: forwarded as is */ }
    if (body && provider === 'openai' && body.stream && /chat\/completions/.test(rest) && !body.stream_options?.include_usage) {
      body.stream_options = { ...(body.stream_options ?? {}), include_usage: true }; raw = Buffer.from(JSON.stringify(body));
    }
    const model = body?.model ?? '';
    const reservation = reservationFor(provider, model, raw.length, body);
    if (state.spent + state.reserved + reservation > capUsd) {
      return send(402, { error: { type: 'budget_exceeded', message: `api-meter cap ${capUsd} USD: spent ${state.spent.toFixed(2)}, reserved ${state.reserved.toFixed(2)}, this request needs up to ${reservation.toFixed(2)}` } });
    }
    state.reserved += reservation;
    let settled = false;
    const settle = (usd, usage, estimated) => {
      if (settled) return; settled = true; state.reserved = Math.max(0, state.reserved - reservation);
      record({ provider, model, path: rest, usage: usage ?? null, usd: +usd.toFixed(6), estimated });
    };
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!['host', 'authorization', 'x-api-key', 'content-length', 'accept-encoding', 'connection'].includes(k)) headers[k] = v;
    if (provider === 'anthropic') { headers['x-api-key'] = keys.anthropic; headers['anthropic-version'] ??= '2023-06-01'; } else headers.authorization = `Bearer ${keys.openai}`;
    headers['accept-encoding'] = 'identity';
    let up;
    try { up = await fetchImpl(upstream[provider] + rest + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw }); }
    catch (e) { settle(reservation, null, true); return send(502, { error: { type: 'upstream_unreachable', message: String(e.message).slice(0, 120) } }); }
    const outHeaders = {}; up.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) outHeaders[k] = v; });
    res.writeHead(up.status, outHeaders);
    const isSse = /text\/event-stream/.test(up.headers.get('content-type') ?? '');
    let buf = '', startUsage = null, deltaUsage = null, finalUsage = null, seenModel = model, whole = '';
    const feed = (txt) => {
      if (!isSse) { whole += txt; return; }
      buf += txt; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        const u = usageFromEvent(ev); if (!u) continue;
        if (u.model) seenModel = u.model;
        if (u.kind === 'start') startUsage = u.usage; else if (u.kind === 'delta') deltaUsage = { ...(deltaUsage ?? {}), ...u.usage }; else finalUsage = u.usage;
      }
    };
    const finish = () => {
      let usage = null;
      if (!isSse) { try { const j = JSON.parse(whole); usage = j.usage; seenModel = j.model ?? seenModel; } catch { /* leave null */ } }
      else usage = finalUsage ?? (startUsage || deltaUsage ? { ...(startUsage ?? {}), ...(deltaUsage ?? {}) } : null);
      const usd = up.ok ? costOf(provider, seenModel, usage) : 0;
      if (usd === null) settle(reservation, usage, true); else settle(usd, usage, false);
    };
    if (!up.body) { finish(); return res.end(); }
    const stream = Readable.fromWeb(up.body);
    stream.on('data', (c) => { feed(c.toString('utf8')); res.write(c); });
    stream.on('end', () => { finish(); res.end(); });
    stream.on('error', () => { settle(reservation, null, true); res.destroy(); });
    res.on('close', () => { if (!settled) settle(reservation, null, true); });
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { try { res.writeHead(500); res.end(JSON.stringify({ error: { type: 'meter_error', message: String(e.message).slice(0, 120) } })); } catch { /* closed */ } log(e); }); });
  return { server, state };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const { server, state } = createMeter({
    capUsd: Number(arg('--cap-usd', '150')), token: process.env.API_METER_TOKEN,
    ledger: arg('--ledger', path.join(os.homedir(), '.local/state/arena-flywheel/api-spend.jsonl')),
    keys: { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY }, log: (e) => console.error(String(e.message).slice(0, 160)),
  });
  server.listen(Number(arg('--port', '4010')), '127.0.0.1', () => console.log(JSON.stringify({ listening: 4010, spent: state.spent, cap: Number(arg('--cap-usd', '150')) })));
}
