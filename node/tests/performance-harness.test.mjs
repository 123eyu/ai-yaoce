import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('performance baseline instrumentation supports Windows CRLF checkout', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-yaoce-harness-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'desktop'));
  const source = "const smoke = process.argv.includes('--smoke');\nif (smoke && !smokeVisible) app.commandLine.appendSwitch('disable-gpu');\nfixture: smoke\nasync function runSmoke() {\n";
  await writeFile(join(directory, 'desktop/main.cjs'), source.replaceAll('\n', '\r\n'));
  execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/prepare-performance-baseline.cjs', import.meta.url)), directory]);
  const prepared = await readFile(join(directory, 'desktop/main.cjs'), 'utf8');
  assert.ok(prepared.includes('fixture: smoke && !performanceCheck'));
  assert.ok(prepared.includes("require('./performance.cjs').measure"));
});
