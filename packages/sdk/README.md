# @metaharness/sdk

Convenience helpers for harness authors. Wraps [`@metaharness/kernel`](../kernel-js/) with typed, validated, named definitions so your IDE catches typos before they reach the kernel.

## Use

```js
import {
  defineHarness, defineAgent, defineSkill, defineTool,
  defineHook, defineMcpServer,
} from '@metaharness/sdk';

const triager = defineAgent({
  name: 'triager',
  systemPrompt: 'You triage support tickets.',
  tier: 'small',
});

const escalator = defineAgent({
  name: 'escalator',
  systemPrompt: 'You decide when to page humans.',
  tier: 'frontier',
});

const kbServer = defineMcpServer({
  name: 'kb',
  command: ['npx', '-y', 'my-bot', 'mcp', 'kb'],
});

export default defineHarness({
  name: 'my-bot',
  description: 'Customer support harness',
  agents: [triager, escalator],
  mcpServers: [kbServer],
});
```

## Why use it instead of building HarnessSpec directly

| Without SDK | With SDK |
|---|---|
| Field-name typos compile (e.g. `system_prompt` vs `systemPrompt`) | TypeScript catches |
| Invalid tier passes silently | Throws at define time |
| Two agents named the same → confused dispatch | Throws `agent name collision` |
| Harness name accepts `MyBot` | Enforces kebab-case (npm-publishable) |
| Explicitly empty description | Throws (omitted descriptions remain optional) |

All `define*()` helpers return frozen objects so you can't accidentally mutate them.

## License

MIT
