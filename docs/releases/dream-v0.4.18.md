# MetaHarness 0.4.18 — Dream integration and security fixes

Packages: `metaharness@0.4.18`, `@metaharness/sdk@0.1.1`, and `@metaharness/flywheel@0.1.13`.

Integrates Dream PRs #406, #410, #414, #419, #421, and #423 with review fixes:

- Bound receipt canonicalization depth and reject non-finite signed numbers. Evaluator failures stop before invalid scores can enter signed evidence. Finite receipt bytes remain compatible with existing signatures and JSON transport.
- Clear all positive proof classifications when evidence cannot be digested.
- Emit default-deny MCP policy for Claude Code and native Codex, Hermes, OpenClaw, Copilot, and OpenCode registrations. Preserve generated overlays and user policy edits during upgrades. Policy files remain configuration; enforcement belongs to the host/runtime.
- Reject ambiguous command-like project names while preserving explicit `new doctor` and overwrite protection.
- Validate SDK names and duplicate registrations; omitted harness descriptions remain supported.
- Reject invalid SWE-bench cost limits in all five solver entrypoints.
- Update the test toolchain to Vitest 4.1.12 and regenerate the dependency lock. Pin Candle's upstream ZIP 9 fix at `70f72e9cfdbfc570846ca363ead2135394af3e9a` pending a registry release. No new vulnerability suppressions were added.
- Reduce allocations in object canonicalization. An offline receipt microbenchmark on Node 22.23.2 measured a 1.19× speedup over the hardened map/join implementation, with identical bytes (seven alternating samples of 50,000 iterations). This is a microbenchmark, not an end-to-end agent performance claim.

The scoped Dream release workflow packs once, tests installed ESM/CJS and CLI entrypoints, publishes those exact tarballs, and verifies npm and GitHub download hashes. It requires successful CI and Security workflows on the merged source SHA. Darwin package publication remains separate.

Reproduce: `npm ci --ignore-scripts`, `npm run build`, `npx vitest run --maxWorkers=2`, `node --test bench/swebench/cost-guard.test.mjs`, `npm audit`, `node bench/dream/canonicalization.mjs`, `node scripts/dream-release.mjs pack`, and `node scripts/dream-release.mjs smoke`.
