import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { matchRule, SOURCES } from './pricing-rules.mjs';
import { sourceDefinition } from './source-registry.mjs';

export const SCAN_LIMITS = Object.freeze({ files: 400, bytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, lineBytes: 4 * 1024 * 1024, entries: 12000, days: 35 });
const DAY = 86400_000;
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const number = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(value, 1e15)) : 0;
const total = tokens => tokens.input + tokens.cached + tokens.written + tokens.output;
const emptyTokens = () => ({ input: 0, cached: 0, written: 0, output: 0 });
async function sampleBoundary(handle, offset) {
  const length = Math.min(128, offset);
  const head = Buffer.alloc(length), tail = Buffer.alloc(length);
  await handle.read(head, 0, length, 0);
  await handle.read(tail, 0, length, offset - length);
  return Buffer.concat([head, tail]);
}
export function codexTokens(value) {
  const input = number(value.input_tokens);
  const cached = Math.min(input, number(value.cached_input_tokens));
  const written = Math.min(input - cached, number(value.cache_write_input_tokens));
  return { input: input - cached - written, cached, written, output: number(value.output_tokens) };
}
export function claudeTokens(value) {
  return { input: number(value.input_tokens), cached: number(value.cache_read_input_tokens), written: number(value.cache_creation_input_tokens), output: number(value.output_tokens) };
}
export function mergeRecord(record, previous) {
  return { ...record, at: Math.min(record.at, previous.at), model: record.model === '未知模型' ? previous.model : record.model,
    provider: record.provider || previous.provider, failed: record.failed || previous.failed,
    priceUnsupported: record.priceUnsupported || previous.priceUnsupported,
    tokens: Object.fromEntries(Object.keys(record.tokens).map(key => [key, Math.max(record.tokens[key], previous.tokens[key])])) };
}

export class UsageLogParser {
  constructor(source, fileID) {
    this.source = source;
    this.session = fileID;
    this.model = '未知模型';
    this.provider = '';
    this.cumulative = emptyTokens();
    this.hasTotal = false;
    this.sequence = 0;
    this.records = new Map();
    this.malformed = 0;
    this.discontinuities = 0;
  }
  consume(line) {
    if (!line.length) return;
    let row;
    try { row = JSON.parse(line); if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(); }
    catch { this.malformed++; return; }
    this.sequence++;
    const at = typeof (row.timestamp ?? row.ts) === 'string' ? Date.parse(row.timestamp ?? row.ts) : NaN;
    if (sourceDefinition(this.source)?.kind === 'domestic') return;
    if (this.source === 'claude') {
      const message = row.message;
      if (row.type !== 'assistant' || !message || !Number.isFinite(at)) return;
      const model = text(message.model, '未知模型');
      const failed = row.isApiErrorMessage === true;
      if (model === '<synthetic>' && !failed) return;
      const identity = [message.id, row.requestId, row.uuid].find(value => typeof value === 'string');
      if (identity === undefined) return;
      const usage = message.usage ?? {};
      const tokens = claudeTokens(usage);
      if (!total(tokens) && !failed) return;
      const session = text(row.sessionId, this.session);
      const record = { id: `claude/${session}/${identity}`, source: 'claude', at, session, model, provider: 'anthropic', tokens, failed,
        priceUnsupported: number(usage.cache_creation?.ephemeral_1h_input_tokens) > 0 };
      this.records.set(record.id, this.records.has(record.id) ? mergeRecord(record, this.records.get(record.id)) : record);
      return;
    }
    const payload = row.payload ?? {};
    if (row.type === 'session_meta') { this.session = text(payload.id, text(payload.session_id, this.session)); this.provider = text(payload.model_provider, this.provider); }
    if (row.type === 'turn_context') this.model = text(payload.model, this.model);
    if (row.type !== 'event_msg' || !Number.isFinite(at)) return;
    if (payload.type === 'error') {
      const id = `codex/${this.session}/error/${at}/${this.sequence}`;
      this.records.set(id, { id, source: 'codex', at, session: this.session, model: this.model, provider: this.provider, tokens: emptyTokens(), failed: true });
    }
    const info = payload.info;
    if (payload.type !== 'token_count' || !info?.total_token_usage) return;
    const current = codexTokens(info.total_token_usage);
    let delta = Object.fromEntries(Object.keys(current).map(key => [key, Math.max(0, current[key] - this.cumulative[key])]));
    if (this.hasTotal && total(current) < total(this.cumulative)) { this.discontinuities++; return; }
    if (this.hasTotal && Math.abs(total(delta) - (total(current) - total(this.cumulative))) > 0.001) { this.discontinuities++; this.cumulative = current; return; }
    if (!this.hasTotal && info.last_token_usage) {
      const last = codexTokens(info.last_token_usage);
      if (total(current) > total(last)) { delta = last; this.discontinuities++; }
    }
    this.cumulative = current;
    this.hasTotal = true;
    if (!total(delta)) return;
    const id = `codex/${this.session}/${current.input}/${current.cached}/${current.written}/${current.output}`;
    this.records.set(id, { id, source: 'codex', at, session: this.session, model: this.model, provider: this.provider, tokens: delta });
  }
  prune(horizon) { for (const [id, record] of this.records) if (record.at < horizon) this.records.delete(id); }
}

export function summarize(source, records, catalog, now = Date.now()) {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const month = new Date(now); month.setDate(1); month.setHours(0, 0, 0, 0);
  const since = now - 7 * DAY;
  const result = { source, todayTokens: 0, weekTokens: 0, monthTokens: 0, todayRecords: 0, weekRecords: 0,
    estimatedUSD: 0, monthEstimatedUSD: 0, pricedRecords: 0, unpricedRecords: 0, manualRecords: 0, monthUnpricedRecords: 0,
    models: [], providers: [], warnings: [], fileCount: 0, latest: null };
  const unique = new Map(), models = new Map(), providers = new Set();
  for (const record of records) {
    if (record.source !== source || record.at < Math.min(since, +month) || record.at > now) continue;
    unique.set(record.id, unique.has(record.id) ? mergeRecord(record, unique.get(record.id)) : record);
  }
  for (const record of unique.values()) {
    result.latest = Math.max(result.latest ?? 0, record.at);
    if (record.provider) providers.add(record.provider);
    const tokens = total(record.tokens), estimate = catalog.estimate(record);
    if (record.at >= +month && tokens > 0) {
      result.monthTokens += tokens;
      if (estimate !== null) result.monthEstimatedUSD += estimate;
      else result.monthUnpricedRecords++;
    }
    if (record.at < since || tokens <= 0) continue;
    result.weekTokens += tokens;
    result.weekRecords++;
    const model = models.get(record.model) ?? { id: record.model, tokens: 0, count: 0 };
    model.tokens += tokens; model.count++; models.set(record.model, model);
    if (record.at < +midnight) continue;
    result.todayTokens += tokens; result.todayRecords++;
    if (estimate !== null) {
      result.estimatedUSD += estimate; result.pricedRecords++;
      if (matchRule(catalog.pricing, source, record.provider, record.model)) result.manualRecords++;
    } else result.unpricedRecords++;
  }
  result.latest = result.latest === null ? null : new Date(result.latest).toISOString();
  result.models = [...models.values()].sort((left, right) => right.tokens - left.tokens || left.id.localeCompare(right.id));
  result.providers = [...providers].sort();
  return result;
}

export class ClientTelemetryReader {
  constructor({ home, environment = {} }) {
    this.home = home;
    this.environment = environment;
    this.files = new Map();
    this.readBuffer = Buffer.alloc(262144);
    this.cursor = 0;
    this.lastScan = { bytes: 0, files: 0 };
  }
  async roots() {
    const roots = [];
    for (const home of new Set([join(this.home, '.codex'), this.environment.CODEX_HOME].filter(Boolean)))
      for (const folder of ['sessions', 'archived_sessions']) roots.push({ path: join(home, folder), source: 'codex' });
    for (const home of new Set([join(this.home, '.claude'), this.environment.CLAUDE_CONFIG_DIR].filter(Boolean))) roots.push({ path: join(home, 'projects'), source: 'claude' });
    for (const source of ['zcodex', 'dsh-deepseek', 'qwen-codex', 'kimi-codex']) {
      for (const folder of sourceDefinition(source)?.roots ?? []) roots.push({ path: join(this.home, folder), source });
    }
    return roots;
  }
  async scan(now = Date.now()) {
    const horizon = now - SCAN_LIMITS.days * DAY;
    this.issues = Object.fromEntries(SOURCES.map(source => [source, new Set()]));
    const candidates = [], seen = new Set();
    let visited = 0;
    const walk = async (directory, source) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') this.issues[source].add('部分日志目录不可读'); return; }
      for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
        if (++visited > SCAN_LIMITS.entries) { this.issues[source].add('目录扫描达到上限，统计不完整'); break; }
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { await walk(path, source); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        try {
          const stat = await lstat(path);
          if (stat.mtimeMs < horizon) continue;
          const canonical = await realpath(path);
          if (seen.has(canonical)) continue;
          seen.add(canonical); candidates.push({ path: canonical, source, stat });
        } catch { this.issues[source].add('部分日志不可读'); }
      }
    };
    for (const root of await this.roots()) await walk(root.path, root.source);
    candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || left.path.localeCompare(right.path));
    const active = new Set(candidates.map(candidate => candidate.path));
    for (const path of this.files.keys()) if (!active.has(path)) this.files.delete(path);
    this.lastScan = { bytes: 0, files: 0 };
    const ordered = candidates.slice(this.cursor).concat(candidates.slice(0, this.cursor));
    let processed = 0;
    for (const candidate of ordered) {
      if (processed >= SCAN_LIMITS.files || this.lastScan.bytes >= SCAN_LIMITS.bytes) break;
      processed++; this.lastScan.files++;
      await this.readCandidate(candidate, horizon);
    }
    this.cursor = candidates.length ? (this.cursor + processed) % candidates.length : 0;
    if (processed < candidates.length) for (const source of SOURCES) this.issues[source].add('本批扫描达到上限，后续批次继续');
    return this.records(horizon);
  }
  async readCandidate({ path, source, stat }, horizon) {
    let state = this.files.get(path);
    const reset = !state || stat.ino !== state.ino || stat.size < state.offset || ((stat.mtimeMs !== state.modified || stat.ctimeMs !== state.changed) && stat.size <= state.size);
    if (reset) state = { offset: 0, parser: new UsageLogParser(source, path), pending: Buffer.alloc(0), dropping: false, committed: null };
    state.ino = stat.ino; state.modified = stat.mtimeMs; state.changed = stat.ctimeMs; state.size = stat.size;
    this.files.set(path, state);
    let handle;
    try {
      if (state.offset < stat.size) handle = await open(path, 'r');
      if (handle && state.signature && !(await sampleBoundary(handle, state.offset)).equals(state.signature)) {
        state.offset = 0; state.parser = new UsageLogParser(source, path);
        state.pending = Buffer.alloc(0); state.dropping = false; state.committed = null;
      }
      let budget = Math.min(SCAN_LIMITS.fileBytes, SCAN_LIMITS.bytes - this.lastScan.bytes);
      while (budget > 0 && state.offset < stat.size) {
        const buffer = this.readBuffer;
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, budget, stat.size - state.offset), state.offset);
        if (!bytesRead) break;
        budget -= bytesRead; this.lastScan.bytes += bytesRead; state.offset += bytesRead;
        let chunk = buffer.subarray(0, bytesRead);
        if (state.dropping) {
          const newline = chunk.indexOf(10);
          if (newline < 0) continue;
          state.dropping = false; chunk = chunk.subarray(newline + 1);
        }
        state.pending = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk;
        let start = 0, newline;
        while ((newline = state.pending.indexOf(10, start)) >= 0) {
          if (newline - start <= SCAN_LIMITS.lineBytes) state.parser.consume(state.pending.subarray(start, newline).toString('utf8'));
          else this.issues[source].add('已跳过超大日志行');
          start = newline + 1;
        }
        state.pending = Buffer.from(state.pending.subarray(start));
        if (state.pending.length > SCAN_LIMITS.lineBytes) { state.pending = Buffer.alloc(0); state.dropping = true; this.issues[source].add('已跳过超大日志行'); }
      }
      state.complete = state.offset >= stat.size;
      if (handle) state.signature = await sampleBoundary(handle, state.offset);
      if (state.complete) state.committed = null;
      else this.issues[source].add('日志尚未读完，下批从游标继续');
      state.parser.prune(horizon); state.committed?.prune(horizon);
      if (state.parser.malformed) this.issues[source].add('部分计量日志格式无效');
      if (state.parser.discontinuities) this.issues[source].add('累计计数不连续，未猜测缺失用量');
    } catch { this.issues[source].add('部分日志读取失败'); }
    finally { await handle?.close().catch(() => {}); }
  }
  records(horizon = Date.now() - SCAN_LIMITS.days * DAY) {
    const result = [];
    for (const state of this.files.values()) {
      const parser = state.committed ?? state.parser;
      parser.prune(horizon);
      for (const record of parser.records.values()) result.push(record);
    }
    return result;
  }
  summaries(catalog, now = Date.now()) {
    const records = this.records();
    return Object.fromEntries(SOURCES.map(source => {
      const scoped = records;
      const summary = summarize(source, scoped, catalog, now);
      summary.warnings = [...(this.issues?.[source] ?? [])];
      summary.fileCount = [...this.files.values()].filter(state => state.parser.source === source).length;
      if (sourceDefinition(source)?.kind === 'domestic' && summary.fileCount === 0) summary.warnings.push('已预留本地适配器；当前未发现可读取的标准日志文件');
      return [source, summary];
    }));
  }
}
