import {it,expect} from 'vitest';
import {main} from '../packages/create-agent-harness/src/index.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
it('explicit new accepts a reserved-looking project name without forcing overwrite', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dream-cli-'));
 try {expect(await main(['new','doctor','--target',join(dir,'doctor'),'--no-darwin'])).toBe(0);}
 finally {await rm(dir,{recursive:true,force:true});}
});

it('upgrade retains the generated security policy and user edits', async () => {
  const { scaffold } = await import('../packages/create-agent-harness/src/index.js');
  const { upgradeCmd } = await import('../packages/create-agent-harness/src/upgrade-cmd.js');
  const { readFile, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'dream-upgrade-'));
  try {
    await scaffold({ name: 'policy-test', template: 'minimal', host: 'claude-code', targetDir: dir, force: true, generatorVersion: '0.4.18', darwin: false });
    const path = join(dir, '.harness/mcp-policy.json');
    const policy = JSON.parse(await readFile(path, 'utf8'));
    policy.maxToolCallsPerTurn = 2;
    await writeFile(path, JSON.stringify(policy));
    const result = await upgradeCmd([dir, '--apply']);
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8')).maxToolCallsPerTurn).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(['codex', 'openclaw', 'hermes', 'copilot', 'opencode'] as const)('emits a policy for native %s MCP registration', async host => {
  const { scaffold } = await import('../packages/create-agent-harness/src/index.js');
  const { readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'dream-host-policy-'));
  try {
    await scaffold({ name: 'policy-test', template: 'minimal', host, targetDir: dir, force: true, generatorVersion: '0.4.18', darwin: false });
    const policy = JSON.parse(await readFile(join(dir, '.harness/mcp-policy.json'), 'utf8'));
    expect(policy).toMatchObject({ defaultDeny: true, allowShell: false, allowNetwork: false, allowFileWrite: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
