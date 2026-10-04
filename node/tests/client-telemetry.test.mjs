import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, appendFile, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLogParser, codexTokens, claudeTokens, summarize, ClientTelemetryReader, SCAN_LIMITS } from '../client-telemetry.mjs';
import { LocalPriceCatalog } from '../pricing-rules.mjs';

const now = Date.now();
const stamp = new Date(now).toISOString();
const count = (input, output = 0, cached = 0, extra = {}) => ({ type: 'event_msg', timestamp: stamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached }, ...extra } } });
const metadata = [{ type: 'session_meta', payload: { id: 'session', model_provider: 'relay' } }, { type: 'turn_context', payload: { model: 'custom-long-model-name' } }];
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const assistant = (id, usage, extra = {}) => ({ type: 'assistant', timestamp: stamp, sessionId: 'session', message: { id, model: 'claude-test', usage }, ...extra });

test('Codex inclusive cache input differs from Claude additive cache input', () => {
  assert.deepEqual(codexTokens({ input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 20, output_tokens: 5 }), { input: 50, cached: 30, written: 20, output: 5 });
  assert.deepEqual(claudeTokens({ input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 5 }), { input: 100, cached: 30, written: 20, output: 5 });
  assert.deepEqual(codexTokens({ input_tokens: -1, output_tokens: '20', cached_input_tokens: Infinity }), { input: 0, cached: 0, written: 0, output: 0 });
});

test('Codex cumulative snapshots deduplicate and preserve model per event', () => {
  const parser = new UsageLogParser('codex', 'file');
  for (const row of [...metadata, count(100, 10, 30), count(100, 10, 30), { type: 'turn_context', payload: { model: 'next-model' } }, count(140, 15, 40)]) parser.consume(JSON.stringify(row));
  const records = [...parser.records.values()];
  assert.equal(records.length, 2);
  assert.deepEqual(records[1].tokens, { input: 30, cached: 10, written: 0, output: 5 });
  assert.equal(records[0].model, 'custom-long-model-name'); assert.equal(records[1].model, 'next-model');
  const summary = summarize('codex', records.concat(records), new LocalPriceCatalog(), now + 1);
  assert.equal(summary.weekTokens, 155); assert.equal(summary.weekRecords, 2); assert.equal(summary.unpricedRecords, 2);
});

test('Codex initial partial history, rollback and category shifts never inflate usage', () => {
  const parser = new UsageLogParser('codex', 'file');
  parser.consume(JSON.stringify(count(1000, 100, 0, { last_token_usage: { input_tokens: 10, output_tokens: 2 } })));
  parser.consume(JSON.stringify(count(900, 90)));
  parser.consume(JSON.stringify(count(1100, 110, 150)));
  parser.consume(JSON.stringify(count(1200, 120, 160)));
  assert.equal(parser.discontinuities, 3);
  assert.equal([...parser.records.values()].reduce((sum, record) => sum + Object.values(record.tokens).reduce((value, item) => value + item, 0), 0), 122);
});

test('Claude repeated assistant fragments merge maxima; hourly cache stays unpriced', () => {
  const parser = new UsageLogParser('claude', 'file');
  for (const row of [assistant('message', { input_tokens: 100, output_tokens: 5 }), assistant('message', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20 }),
    assistant('hourly', { input_tokens: 1, cache_creation_input_tokens: 2, cache_creation: { ephemeral_1h_input_tokens: 2 } })]) parser.consume(JSON.stringify(row));
  assert.equal(parser.records.size, 2);
  assert.deepEqual(parser.records.get('claude/session/message').tokens, { input: 100, output: 10, cached: 20, written: 0 });
  assert.equal(parser.records.get('claude/session/hourly').priceUnsupported, true);
});

test('source isolation and metadata-only retention; malformed rows warn without content', () => {
  const parser = new UsageLogParser('claude', 'file');
  parser.consume(JSON.stringify(assistant('message', { input_tokens: 4 }, { body: 'SECRET_BODY', apiKey: 'SECRET_KEY' })));
  parser.consume('{SECRET');
  assert.equal(parser.malformed, 1);
  assert.ok(!JSON.stringify([...parser.records]).includes('SECRET'));
  assert.equal(summarize('codex', [...parser.records.values()], new LocalPriceCatalog(), now + 1).weekTokens, 0);
});

test('zero-token failures do not become priced or unpriced billable records', () => {
  const parser = new UsageLogParser('claude', 'file');
  parser.consume(JSON.stringify(assistant('failure', {}, { isApiErrorMessage: true })));
  const summary = summarize('claude', [...parser.records.values()], new LocalPriceCatalog(), now + 1);
  assert.equal(summary.todayRecords, 0); assert.equal(summary.weekRecords, 0);
  assert.equal(summary.unpricedRecords, 0); assert.equal(summary.monthUnpricedRecords, 0);
  assert.deepEqual(summary.models, []); assert.ok(summary.latest);
});

async function fixture(context) {
  const home = await mkdtemp(join(tmpdir(), 'mirasim-reader-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.codex', 'sessions'); await mkdir(directory, { recursive: true });
  return { home, directory, reader: new ClientTelemetryReader({ home }) };
}

test('incremental append, incomplete final line, same-size rewrite, truncation and removal', async context => {
  const { directory, reader } = await fixture(context);
  const path = join(directory, 'one.jsonl');
  await writeFile(path, lines([...metadata, count(100)]));
  await reader.scan(); assert.equal(reader.summaries(new LocalPriceCatalog()).codex.weekTokens, 100);
  await appendFile(path, JSON.stringify(count(200)));
  await reader.scan(); assert.equal(reader.summaries(new LocalPriceCatalog()).codex.weekTokens, 100);
  await appendFile(path, '\n'); await reader.scan(); assert.equal(reader.summaries(new LocalPriceCatalog()).codex.weekTokens, 200);
  await writeFile(path, lines([...metadata, count(300), count(400)]));
  await utimes(path, new Date(), new Date(Date.now() + 2000));
  await reader.scan(); assert.equal(reader.summaries(new LocalPriceCatalog()).codex.weekTokens, 400);
  await writeFile(path, lines([...metadata, count(10)])); await reader.scan();
  assert.equal(reader.summaries(new LocalPriceCatalog()).codex.weekTokens, 10);
  await rm(path); await reader.scan(); assert.equal(reader.records().length, 0);
});

test('large file resumes beyond 8MiB and huge lines do not consume unbounded memory', async context => {
  const { directory, reader } = await fixture(context);
  const path = join(directory, 'large.jsonl');
  await writeFile(path, lines(metadata) + 'x'.repeat(9 * 1024 * 1024) + '\n' + lines([count(77)]));
  await reader.scan(); assert.ok(reader.lastScan.bytes <= SCAN_LIMITS.fileBytes); assert.equal(reader.records().length, 0);
  await reader.scan(); assert.equal(reader.summaries(new LocalPriceCatalog()).codex.weekTokens, 77);
  assert.ok([...reader.files.values()].every(state => state.pending.length <= SCAN_LIMITS.lineBytes));
});

test('batch budget is 64MiB and files beyond the first batch are eventually read', async context => {
  const { directory, reader } = await fixture(context);
  const padding = 'x'.repeat(8 * 1024 * 1024) + '\n';
  for (let index = 0; index < 9; index++) await writeFile(join(directory, `${index}.jsonl`), padding + lines([{ type: 'session_meta', payload: { id: `${index}` } }, count(1)]));
  await reader.scan(); assert.ok(reader.lastScan.bytes <= SCAN_LIMITS.bytes);
  for (let index = 0; index < 3; index++) { await reader.scan(); assert.ok(reader.lastScan.bytes <= SCAN_LIMITS.bytes); }
  assert.equal(reader.summaries(new LocalPriceCatalog()).codex.weekTokens, 9);
});

test('400-file batch rotation, 35-day horizon and symlink exclusions', async context => {
  const { directory, reader } = await fixture(context);
  for (let index = 0; index < 401; index++) await writeFile(join(directory, `${index}.jsonl`), lines([{ type: 'session_meta', payload: { id: `${index}` } }, count(1)]));
  const old = join(directory, 'old.jsonl'); await writeFile(old, lines([count(999)]));
  await utimes(old, new Date(now - 36 * 86400_000), new Date(now - 36 * 86400_000));
  if (process.platform !== 'win32') await symlink(join(directory, '0.jsonl'), join(directory, 'linked.jsonl'));
  await reader.scan(); assert.equal(reader.lastScan.files, 400);
  await reader.scan(); assert.equal(reader.lastScan.files, 400);
  assert.equal(reader.summaries(new LocalPriceCatalog()).codex.weekTokens, 401);
});

test('legacy relay roots are ignored and domestic sources stay empty without an adapter', async context => {
  const { home, reader } = await fixture(context);
  const managed = join(home, '.mirasim', 'agent-homes', 'claude-relay', 'projects'); await mkdir(managed, { recursive: true });
  await writeFile(join(managed, 'one.jsonl'), lines([assistant('same', { input_tokens: 5 })]));
  await reader.scan(); const summaries = reader.summaries(new LocalPriceCatalog());
  assert.equal(summaries.claude.weekTokens, 0); assert.equal(summaries.codex.weekTokens, 0);
  for (const source of ['zcodex', 'dsh-deepseek', 'qwen-codex', 'kimi-codex']) {
    assert.equal(summaries[source].weekTokens, 0);
    assert.ok(summaries[source].warnings.some(warning => warning.includes('本地适配器')));
  }
});

test('domestic source roots do not parse arbitrary JSONL as Codex usage', async context => {
  const { home, reader } = await fixture(context);
  const domestic = join(home, '.qwen'); await mkdir(domestic, { recursive: true });
  await writeFile(join(domestic, 'events.jsonl'), lines([{ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 999 } } } }]));
  await reader.scan();
  assert.equal(reader.summaries(new LocalPriceCatalog()).codex.weekTokens, 0);
  assert.equal(reader.summaries(new LocalPriceCatalog())['qwen-codex'].weekTokens, 0);
});
