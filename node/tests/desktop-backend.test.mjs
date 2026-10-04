import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDesktopBackend } from '../desktop-backend.mjs';

const run = promisify(execFile);
const rulesFor = (model, source = 'codex', input = 0) => ({ rules: [{ source, provider: '', model, alias: '', prices: { input, output: 0, cache_read: 0, cache_write: 0 } }] });
async function fixture(context, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mirasim-backend-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'rules.json');
  const backend = createDesktopBackend({ fixture: true, configPath, ...options });
  context.after(() => backend.close());
  return { backend, directory, configPath };
}

test('SDD API shape, fixture contains six sources and price changes recalculate without scanning', async context => {
  const updates = [];
  const { backend, configPath } = await fixture(context, { onUpdate: value => updates.push(value) });
  assert.deepEqual(Object.keys(backend).sort(), ['close', 'getPricing', 'refresh', 'savePricing', 'snapshot']);
  const initial = await backend.snapshot();
  assert.equal(initial.version, '2.0.0');
  assert.deepEqual(Object.keys(initial).sort(), ['fixture', 'sources', 'updatedAt', 'version']);
  for (const source of ['codex', 'claude']) { assert.ok(initial.sources[source].todayTokens > 0); assert.ok(initial.sources[source].estimatedUSD > 0); }
  for (const source of ['zcodex', 'dsh-deepseek', 'qwen-codex', 'kimi-codex']) { assert.equal(initial.sources[source].todayTokens, 0); }
  const model = initial.sources.codex.models[0].id;
  const saved = await backend.savePricing(rulesFor(model));
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), saved);
  const updated = await backend.snapshot();
  assert.equal(updated.sources.codex.estimatedUSD, 0); assert.equal(updated.sources.codex.manualRecords, 1);
  assert.equal(updated.sources.claude.estimatedUSD, initial.sources.claude.estimatedUSD);
  await backend.savePricing({ rules: [] }); assert.equal((await backend.snapshot()).sources.codex.estimatedUSD, initial.sources.codex.estimatedUSD);
  assert.ok(updates.length >= 3);
  updated.sources.codex.todayTokens = -1; assert.ok((await backend.snapshot()).sources.codex.todayTokens > 0);
});

test('invalid saves preserve active rules; callback errors warn; closed backend rejects', async context => {
  const { backend } = await fixture(context, { onUpdate: () => { throw new Error('SECRET_ERROR'); } });
  const snapshot = await backend.snapshot();
  assert.ok(snapshot.sources.codex.warnings.some(value => value.includes('回调失败')));
  await assert.rejects(backend.savePricing(rulesFor('model', 'codex', NaN)));
  assert.deepEqual(await backend.getPricing(), { rules: [] });
  await backend.close(); await backend.close();
  await assert.rejects(backend.refresh(), /已关闭/); await assert.rejects(backend.snapshot(), /已关闭/);
});

test('concurrent saves are serialized and corrupt configuration preserves last good rules', async context => {
  const { backend, configPath } = await fixture(context);
  await backend.snapshot();
  await Promise.all([backend.savePricing(rulesFor('gpt-5.6', 'codex', 2)), backend.savePricing(rulesFor('gpt-5.6', 'codex', 3))]);
  assert.equal((await backend.getPricing()).rules[0].prices.input, 3);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).rules[0].prices.input, 3);
  await writeFile(configPath, 'SECRET_INVALID');
  const value = await backend.refresh();
  assert.equal((await backend.getPricing()).rules[0].prices.input, 3);
  assert.ok(value.sources.codex.warnings.some(warning => warning.includes('价格配置读取失败')));
  assert.ok(!JSON.stringify(value).includes('SECRET_INVALID'));
});

test('headless import and fixture cannot read real home, account files, start processes or HTTP', async () => {
  const backendURL = new URL('../desktop-backend.mjs', import.meta.url).href;
  const script = `
    import os from 'node:os'; import fs from 'node:fs'; import fsp from 'node:fs/promises'; import http from 'node:http'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const forbidden = () => { throw new Error('FORBIDDEN_REAL_ACCESS'); };
    os.homedir = forbidden; cp.execFile = forbidden; http.createServer = forbidden;
    const read = fs.readFileSync, readAsync = fsp.readFile;
    fs.readFileSync = (path, ...args) => String(path).endsWith('.mjs') ? read(path, ...args) : forbidden();
    fsp.readFile = (path, ...args) => String(path).endsWith('.mjs') ? readAsync(path, ...args) : forbidden();
    fs.readdirSync = forbidden; fsp.readdir = forbidden; fsp.open = forbidden;
    syncBuiltinESMExports();
    const {createDesktopBackend} = await import(${JSON.stringify(backendURL)});
    const backend = createDesktopBackend({fixture:true, home:'/must-not-read'});
    const snapshot = await backend.snapshot();
    if (!snapshot.fixture || snapshot.sources.codex.warnings.some(value=>value.includes('失败'))) throw new Error('bad fixture');
    await backend.savePricing({rules:[]}); await backend.refresh(); await backend.close();
    console.log('isolated');`;
  const result = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 10000 });
  assert.equal(result.stdout.trim(), 'isolated'); assert.equal(result.stderr, '');
});

test('isolated live home reads only supplied log roots and no Mirasim does not block clients', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'mirasim-live-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projects = join(directory, '.claude', 'projects'); await mkdir(projects, { recursive: true });
  await writeFile(join(projects, 'test.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'id', model: 'custom', content: 'DO_NOT_EXPOSE_BODY', usage: { input_tokens: 10 } } }) + '\n');
  const backend = createDesktopBackend({ home: directory, configPath: join(directory, 'rules.json') }); context.after(() => backend.close());
  const snapshot = await backend.refresh();
  assert.equal('mirasim' in snapshot, false); assert.equal(snapshot.sources.claude.todayTokens, 10);
  assert.equal(snapshot.sources.claude.unpricedRecords, 1); assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_EXPOSE_BODY'));
  await backend.savePricing(rulesFor('custom', 'claude', 2));
  assert.equal((await backend.snapshot()).sources.claude.estimatedUSD, 0.00002);
});
