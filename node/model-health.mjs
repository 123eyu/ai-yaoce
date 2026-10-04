import { randomUUID } from 'node:crypto';

export const defaultHealthConfig = () => ({ enabled: false, interval: 600, timeout: 30, prompt: 'Reply 1', maxTokens: 8, targets: [] });
const protocols = ['chat', 'responses', 'anthropic'];
const number = (value, low, high, label) => {
  if (!Number.isFinite(value) || value < low || value > high) throw new Error(`${label}必须在${low}～${high}之间`);
  return value;
};

export function validateHealthConfig(value, previous = defaultHealthConfig()) {
  if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.targets)) throw new Error('检测配置无效');
  const config = { enabled: value.enabled,
    interval: number(value.interval, 10, 86400, '间隔秒数'), timeout: number(value.timeout, 1, 300, '超时秒数'),
    maxTokens: number(value.maxTokens, 1, 4096, '输出token上限'), prompt: value.prompt, targets: [] };
  if (!Number.isInteger(config.maxTokens) || typeof config.prompt !== 'string' || !config.prompt.trim() || config.prompt.length > 1000) throw new Error('口令需为1～1000字符；token上限需为整数');
  const identities = new Set(), ids = new Set();
  for (const entry of value.targets) {
    if (!entry || typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 300
      || typeof entry.source !== 'string' || entry.source.length > 100 || typeof entry.enabled !== 'boolean'
      || typeof entry.reasoning !== 'boolean' || !protocols.includes(entry.protocol)) throw new Error('模型/来源/协议无效');
    let url;
    try { url = new URL(entry.endpoint); } catch { throw new Error('请填写完整请求URL'); }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash) throw new Error('仅支持HTTPS或本机HTTP，URL不能带账号/查询参数/片段');
    const id = entry.id || randomUUID();
    if (typeof id !== 'string' || id.length > 100 || ids.has(id)) throw new Error('模型ID重复或无效');
    ids.add(id);
    const old = previous.targets.find(item => item.id === id);
    const endpoint = url.href;
    const apiKey = entry.apiKey || (old?.endpoint === endpoint ? old.apiKey : '');
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /[\r\n]/.test(apiKey)) throw new Error('密钥格式无效');
    const target = { id, source: entry.source.trim(), model: entry.model.trim(), endpoint, protocol: entry.protocol,
      enabled: entry.enabled, reasoning: entry.reasoning, apiKey,
      inputPrice: entry.inputPrice == null ? null : number(entry.inputPrice, 0, 1000000, '输入单价'),
      outputPrice: entry.outputPrice == null ? null : number(entry.outputPrice, 0, 1000000, '输出单价') };
    const identity = JSON.stringify([endpoint, target.protocol, target.model, apiKey]);
    if (identities.has(identity)) throw new Error('同一线路、密钥和模型重复');
    identities.add(identity); config.targets.push(target);
  }
  return config;
}

export function healthRequest(config, target) {
  const headers = { 'content-type': 'application/json' };
  let body = { model: target.model, stream: false };
  if (target.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (target.apiKey) headers['x-api-key'] = target.apiKey;
    body = { ...body, max_tokens: config.maxTokens, messages: [{ role: 'user', content: config.prompt }], thinking: { type: 'disabled' } };
  } else {
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
    if (target.protocol === 'responses') {
      body = { ...body, input: config.prompt, max_output_tokens: config.maxTokens, store: false };
      if (target.reasoning) body.reasoning = { effort: 'low' };
    } else {
      body.messages = [{ role: 'user', content: config.prompt }];
      if (target.reasoning) { body.max_completion_tokens = config.maxTokens; body.reasoning_effort = 'low'; }
      else body.max_tokens = config.maxTokens;
    }
  }
  return { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body) };
}

export function healthResponse(status, data = {}) {
  const states = { 401: '鉴权失败', 403: '鉴权失败', 404: '模型或接口不存在', 408: '超时', 429: '限流' };
  if (status < 200 || status >= 300) return { state: states[status] || (status >= 500 ? '服务错误' : status >= 300 && status < 400 ? '拒绝重定向' : '请求不兼容') };
  if (!data || typeof data !== 'object') data = {};
  const usage = data.usage ?? {};
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  const valid = amount => Number.isFinite(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER;
  const array = value => Array.isArray(value) ? value : [];
  const text = data.choices?.[0]?.message?.content ?? data.output_text
    ?? [...array(data.content), ...array(data.output).flatMap(item => array(item?.content))]
      .filter(part => ['text', 'output_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('');
  const incomplete = data.choices?.[0]?.finish_reason === 'length' || data.stop_reason === 'max_tokens'
    || data.status === 'incomplete' || data.incomplete_details?.reason === 'max_output_tokens';
  return { state: typeof text === 'string' && text.trim() && !data.error && !incomplete ? '可用' : '未确认',
    input: valid(input) ? input : null, output: valid(output) ? output : null };
}

async function boundedJSON(response) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  let total = 0; const chunks = [];
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    total += value.length;
    if (total > 1048576) { await reader.cancel(); return {}; }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export class ModelHealth {
  constructor({ config = defaultHealthConfig(), persist = async () => {}, fetcher = fetch, clock = Date.now, automatic = true } = {}) {
    this.config = validateHealthConfig(config); this.persist = persist; this.fetcher = fetcher; this.clock = clock;
    this.results = new Map(); this.active = new Map(); this.generation = 0; this.closed = false; this.saving = Promise.resolve();
    this.stats = { requests: 0, input: 0, output: 0, unknownUsage: 0, estimatedUSD: 0, unpriced: 0 };
    if (automatic) { this.timer = setInterval(() => this.tick(), 1000); this.timer.unref?.(); }
  }
  snapshot() {
    return { config: { ...this.config, targets: this.config.targets.map(({ apiKey, ...target }) => ({ ...target, hasKey: Boolean(apiKey) })) },
      results: Object.fromEntries([...this.results].map(([id, result]) => [id, { ...result,
        stale: result.checkedAt != null && this.clock() - result.checkedAt > this.config.interval * 1000 }])), stats: { ...this.stats } };
  }
  save(value) {
    const operation = this.saving.then(async () => {
      const next = validateHealthConfig(value, this.config);
      const mustDisable = !next.enabled;
      if (mustDisable) { this.cancel(); this.config.enabled = false; }
      await this.persist(next);
      if (this.closed) throw new Error('检测已关闭');
      const retained = new Map();
      for (const target of next.targets) {
        const old = this.config.targets.find(entry => entry.id === target.id);
        const result = this.results.get(target.id);
        if (!old || !result || ['endpoint', 'protocol', 'model', 'apiKey'].some(key => old[key] !== target[key])) continue;
        const copy = { ...result };
        if (this.active.has(target.id) || copy.state === '检测中') { copy.state = '已取消'; copy.nextAt = this.clock() + next.interval * 1000; }
        if ((!old.enabled && target.enabled) || (!this.config.enabled && next.enabled)) copy.nextAt = 0;
        retained.set(target.id, copy);
      }
      this.cancel(); this.config = next; this.results = retained;
      return this.snapshot();
    });
    this.saving = operation.catch(() => {}); return operation;
  }
  cancel() { this.generation++; for (const controller of this.active.values()) controller.abort(); }
  check(id) {
    if (!this.config.enabled) throw new Error('请先开启并保存检测开关（请求可能收费）');
    for (const target of this.config.targets) if ((!id || target.id === id) && target.enabled && !this.active.has(target.id)) {
      const result = this.results.get(target.id); if (result) result.nextAt = 0;
    }
    this.tick(id); return this.snapshot();
  }
  tick(preferred) {
    if (this.closed || !this.config.enabled) return;
    const due = this.config.targets.filter(target => target.enabled && !this.active.has(target.id)
      && (this.results.get(target.id)?.nextAt ?? 0) <= this.clock())
      .sort((left, right) => left.id === preferred ? -1 : right.id === preferred ? 1
        : (this.results.get(left.id)?.checkedAt ?? 0) - (this.results.get(right.id)?.checkedAt ?? 0));
    for (const target of due) { if (this.active.size >= 2) break; void this.run(target); }
  }
  async run(target) {
    const controller = new AbortController(), generation = this.generation, started = this.clock();
    const previous = this.results.get(target.id), config = this.config;
    this.active.set(target.id, controller); this.stats.requests++;
    this.results.set(target.id, { ...previous, state: '检测中', nextAt: null });
    const timeout = setTimeout(() => controller.abort(), config.timeout * 1000);
    let result, retry = 0;
    try {
      const response = await this.fetcher(target.endpoint, { ...healthRequest(config, target), signal: controller.signal });
      if (response.status === 429) {
        const value = response.headers.get('retry-after');
        retry = value ? Math.max(0, Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.parse(value) - this.clock()) : 0;
      }
      const data = response.ok ? await boundedJSON(response) : {};
      if (!response.ok) await response.body?.cancel();
      result = { ...healthResponse(response.status, data), httpStatus: response.status };
    } catch { result = { state: controller.signal.aborted ? '超时' : '网络失败' }; }
    finally { clearTimeout(timeout); this.active.delete(target.id); }
    if (generation !== this.generation || this.closed) { this.stats.unknownUsage++; this.stats.unpriced++; return; }
    if (result.input == null || result.output == null) this.stats.unknownUsage++;
    this.stats.input += result.input ?? 0; this.stats.output += result.output ?? 0;
    if (result.input != null && result.output != null && target.inputPrice != null && target.outputPrice != null)
      this.stats.estimatedUSD += (result.input * target.inputPrice + result.output * target.outputPrice) / 1000000;
    else this.stats.unpriced++;
    const failures = result.state === '可用' ? 0 : (previous?.failures ?? 0) + 1;
    const delay = Math.max(config.interval * 1000, Math.min(3600000, config.interval * 1000 * 2 ** Math.min(10, failures)), retry || 0);
    this.results.set(target.id, { ...result, failures, checkedAt: this.clock(), latency: this.clock() - started,
      nextAt: result.state === '鉴权失败' ? Number.MAX_SAFE_INTEGER : this.clock() + delay });
  }
  close() { this.closed = true; clearInterval(this.timer); this.cancel(); }
}
