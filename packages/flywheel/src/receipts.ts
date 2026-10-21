// @metaharness/flywheel — Ed25519 receipts. Every promotion is signed; a receiver VERIFIES the
// signature with the embedded public key. Trust comes from the verifiable signature, not from the
// producer — so a lineage can be replayed and audited with no access to the machine that made it.
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, type KeyObject } from 'node:crypto';
import type { PromotionReceipt, Signer } from './types.js';

/** Deterministic, sorted-key JSON canonicalization — the exact bytes that get signed.
 *
 *  `JSON.stringify` collapses `NaN`, `Infinity`, and `-Infinity` to the 4-byte literal `null` (per the
 *  ECMA-262 spec it implements) — so, naively, `canon(NaN) === canon(Infinity) === canon(-Infinity) ===
 *  canon(null)`. RFC 8785 (JSON Canonicalization Scheme) forbids non-finite numbers for exactly this
 *  reason — see also the Rust `json-canon` crate's own documented pitfall: a non-finite input "will
 *  currently output 'null'". That collision is harmless for a plain hash, but every canon-EQUALITY check
 *  in this package (`sealedFieldsAuthentic` below in replay.ts, `validAttestation` in
 *  multigeneration-proof.ts) exists specifically to prove a live field was not changed after it was
 *  signed — and a check of the form `canon(signed) !== canon(live)` cannot tell "live is still NaN" from
 *  "live was silently changed to null/Infinity/-Infinity" if the collapse is left in place. Encode each
 *  as a literal, unquoted token: none of `NaN`/`Infinity`/`-Infinity` is valid JSON syntax for any
 *  string, number, boolean, or null, so none can collide with `JSON.stringify`'s output for any other
 *  value canon() ever produces. Every existing finite number, string, boolean, null, array, and object
 *  canonicalizes byte-identically to before this change. */
export function canon(v: unknown): string {
  if (typeof v === 'number' && !Number.isFinite(v)) {
    if (Number.isNaN(v)) return 'NaN';
    return v > 0 ? 'Infinity' : '-Infinity';
  }
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

/** A per-process Ed25519 signer. For production, wrap a secret-backed or HSM key behind the same
 *  {@link Signer} interface — the flywheel core never sees the private key. */
export function makeSigner(): Signer {
  const kp = generateKeyPairSync('ed25519');
  const pub = (kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
  return {
    publicKey: () => pub,
    sign: (payload: Record<string, unknown>): PromotionReceipt => ({
      payload,
      signature: edSign(null, Buffer.from(canon(payload)), kp.privateKey).toString('base64'),
      publicKey: pub,
      alg: 'ed25519',
    }),
  };
}

/** Independently verify a receipt — recompute canon, check the signature against the EMBEDDED key. */
export function verifyReceipt(r: PromotionReceipt): boolean {
  try {
    const pub: KeyObject = createPublicKey({ key: Buffer.from(r.publicKey, 'base64'), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(canon(r.payload)), pub, Buffer.from(r.signature, 'base64'));
  } catch {
    return false;
  }
}
