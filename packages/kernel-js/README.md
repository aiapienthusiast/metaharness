# @metaharness/kernel

Cross-platform kernel for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

## What it is

A Rust kernel compiled to two npm-shippable targets:

- **WebAssembly** (primary distribution — runs on Node, browser, Cloudflare Workers, Deno, Bun, edge)
- **NAPI-RS native** (per-platform `.node` binaries — escape hatch for Node hot paths)

At load time, `loadKernel()` prefers an installed per-platform native package, then wasm, then the dependency-free JavaScript backend.

## Install

```bash
npm install @metaharness/kernel
```

The native packages (`@metaharness/kernel-darwin-arm64`, `-linux-x64-gnu`, etc.) are optional peers. They are not yet available from the public npm registry (checked 2026-10-27), so they are not installed automatically. The native loader still discovers a compatible package when explicitly installed; otherwise wasm or JavaScript is used. Restore automatic native installation only after the platform packages are published and clean npm 10/11 installs are verified. This source change does not alter already-published kernel versions.

## Usage

```js
import { loadKernel } from '@metaharness/kernel';

const kernel = await loadKernel();
const info = kernel.kernelInfo();
console.log(`kernel ${info.version} (${kernel.backend})`);

// Validate an MCP server spec.
const err = kernel.mcpValidate(JSON.stringify({
  name: 'demo',
  command: ['npx', '-y', 'demo'],
}));
if (err) throw new Error(err);
```

### Memory subsystem (subpath export)

```js
import { rankWithDecay } from '@metaharness/kernel/memory';

const ranked = await rankWithDecay(hits, {
  useDecay: true,
  halfLifeMs: 7 * 24 * 60 * 60 * 1000,  // 7-day half-life
});
```

Wraps `@ruvector/emergent-time` for HNSW decay scoring.

## Subsystems

| Subsystem | What it does |
|---|---|
| `mcp` | MCP server spec + tool registry |
| `hooks` | Lifecycle hook dispatch with permission-decision merge |
| `memory` | AgentDB bridge + emergent-time decay weighting |
| `routing` | 3-tier routing (codemod / Haiku / Sonnet-Opus) |
| `intel` | Intelligence pipeline phases |
| `claims` | Claims-based authorization |
| `witness` | Ed25519-signed provenance manifests |

## License

MIT
