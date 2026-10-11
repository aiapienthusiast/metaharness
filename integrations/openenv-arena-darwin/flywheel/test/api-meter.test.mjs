import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { costOf, createMeter, priceFor, reservationFor, usageFromEvent } from '../api-meter.mjs';

const TOKEN = 'local-test-token-0123456789';
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (s) => new Promise((r) => s.close(() => r()));

async function rig({ capUsd = 100, handler }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meter-'));
  const seen = [];
  const mock = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(c).toString() }); handler(req, res, seen.at(-1)); }); });
  const mp = await listen(mock);
  const ledger = path.join(dir, 'api.jsonl');
  const mk = () => createMeter({ capUsd, ledger, token: TOKEN, keys: { anthropic: 'REAL-ANTHROPIC-KEY', openai: 'REAL-OPENAI-KEY' }, upstream: { anthropic: `http://127.0.0.1:${mp}`, openai: `http://127.0.0.1:${mp}` } });
  const meter = mk(); const port = await listen(meter.server);
  const call = (p, body, headers = { 'x-api-key': TOKEN }) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const done = async () => { await close(meter.server); await close(mock); rmSync(dir, { recursive: true }); };
  return { call, seen, ledger, meter, mk, done, port };
}
const rows = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('prices are overestimates and cost math follows the usage shapes', () => {
  assert.deepEqual(priceFor('anthropic', 'claude-opus-5-5'), { in: 15, out: 75 });
  assert.deepEqual(priceFor('anthropic', 'claude-sonnet-5-5'), { in: 5, out: 25 });
  assert.deepEqual(priceFor('openai', 'gpt-5-mini'), { in: 0.4, out: 3.2 });
  assert.deepEqual(priceFor('openai', 'gpt-5'), { in: 1.5, out: 12 });
  assert.deepEqual(priceFor('openai', 'some-new-model'), { in: 5, out: 25 });
  assert.ok(Math.abs(costOf('anthropic', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) - 30) < 1e-9);
  assert.ok(Math.abs(costOf('openai', 'gpt-5', { prompt_tokens: 1e6, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1e6 } }) - 0.75) < 1e-9);
  assert.equal(costOf('anthropic', 'x', {}), null);
  assert.deepEqual(usageFromEvent({ type: 'message_delta', usage: { output_tokens: 5 } }), { kind: 'delta', usage: { output_tokens: 5 } });
  assert.ok(reservationFor('anthropic', 'claude-opus-5-5', 3000, { max_tokens: 1000 }) > 0.07);
});

test('a local token is required, the real key is injected and a non-stream response is priced into the ledger', async () => {
  const r = await rig({ handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 500 } })); } });
  assert.equal((await r.call('/anthropic/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 100 }, { 'x-api-key': 'wrong' })).status, 401);
  assert.equal(r.seen.length, 0, 'nothing forwarded without the local token');
  const res = await r.call('/anthropic/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 100 });
  assert.equal(res.status, 200);
  assert.equal(r.seen[0].headers['x-api-key'], 'REAL-ANTHROPIC-KEY');
  assert.ok(!JSON.stringify(r.seen[0].headers).includes(TOKEN), 'the local token is not forwarded');
  const [row] = rows(r.ledger);
  assert.ok(Math.abs(row.usd - (1000 * 5 + 500 * 25) / 1e6) < 1e-9);
  assert.equal(row.estimated, false);
  assert.ok(Math.abs((await (await fetch(`http://127.0.0.1:${r.port}/meter`)).json()).spent - row.usd) < 1e-6);
  await r.done();
});

test('the cap is fail-closed: once the next request cannot fit, it gets 402 and is not forwarded', async () => {
  const r = await rig({ capUsd: 0.01, handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); } });
  const res = await r.call('/anthropic/v1/messages', { model: 'claude-opus-5-5', max_tokens: 4096 });
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error.type, 'budget_exceeded');
  assert.equal(r.seen.length, 0);
  await r.done();
});

test('a response with no usage is charged its full reservation, and the spend survives a restart', async () => {
  const r = await rig({ capUsd: 50, handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); } });
  await r.call('/anthropic/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 1000 });
  const [row] = rows(r.ledger);
  assert.equal(row.estimated, true);
  assert.ok(row.usd >= 1000 * 25 / 1e6);
  assert.ok(Math.abs(r.mk().state.spent - row.usd) < 1e-9, 'a new meter starts from the ledger total');
  await r.done();
});

test('an Anthropic SSE stream is priced from message_start and message_delta', async () => {
  const sse = [{ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 2000, output_tokens: 1 } } }, { type: 'content_block_delta' }, { type: 'message_delta', usage: { output_tokens: 700 } }]
    .map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const r = await rig({ handler: (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse); } });
  const res = await r.call('/anthropic/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 2000, stream: true });
  assert.ok((await res.text()).includes('message_delta'), 'the stream passes through unchanged');
  const [row] = rows(r.ledger);
  assert.ok(Math.abs(row.usd - (2000 * 5 + 700 * 25) / 1e6) < 1e-9);
  await r.done();
});

test('OpenAI streaming requests are asked for usage, and the final chunk is priced', async () => {
  const sse = `data: ${JSON.stringify({ model: 'gpt-5', choices: [] })}\n\ndata: ${JSON.stringify({ model: 'gpt-5', usage: { prompt_tokens: 1000, completion_tokens: 200 } })}\n\ndata: [DONE]\n\n`;
  const r = await rig({ handler: (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse); } });
  await r.call('/openai/v1/chat/completions', { model: 'gpt-5', stream: true, max_tokens: 500 }, { authorization: `Bearer ${TOKEN}` });
  assert.equal(JSON.parse(r.seen[0].body).stream_options.include_usage, true);
  assert.equal(r.seen[0].headers.authorization, 'Bearer REAL-OPENAI-KEY');
  assert.ok(Math.abs(rows(r.ledger)[0].usd - (1000 * 1.5 + 200 * 12) / 1e6) < 1e-9);
  await r.done();
});
