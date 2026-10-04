import { homedir } from 'node:os';
import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { ClientTelemetryReader, summarize } from './client-telemetry.mjs';
import { LocalPriceCatalog, SOURCES, defaultPricingPath, loadPricing, savePricingAtomic, validatePricing } from './pricing-rules.mjs';
import { auditSource } from './privacy-audit.mjs';

function fixtureData() {
  const at = Date.now() - 1000;
  const records = SOURCES.filter(source => ['codex', 'claude'].includes(source)).map((source, index) => ({ id: `fixture/${source}`, source, at,
    session: `fixture-${source}`, provider: source === 'claude' ? 'anthropic' : 'openai',
    model: source === 'claude' ? 'claude-sonnet-4' : 'gpt-5.6',
    tokens: { input: 10000 * (index + 1), cached: 2000, written: 0, output: 1500 } }));
  const data = { data: { openai: { models: { 'gpt-5.6': { cost: { input: 4, output: 20, cache_read: 0.4 } } } },
    anthropic: { models: { 'claude-sonnet-4': { cost: { input: 3, output: 15, cache_read: 0.3 } } } } } };
  return { records, data };
}

async function readCatalog(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (stat.size > 8 * 1024 * 1024) throw new Error();
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('本地价格目录不可读，保留上次目录'); }
  finally { await handle?.close().catch(() => {}); }
}

export function createDesktopBackend({ home, configPath, fixture = false, onUpdate } = {}) {
  if (typeof fixture !== 'boolean') throw new Error('fixture 必须为布尔值');
  if (home !== undefined && (typeof home !== 'string' || !home)) throw new Error('home 路径无效');
  if (configPath !== undefined && (typeof configPath !== 'string' || !configPath)) throw new Error('configPath 路径无效');
  if (onUpdate !== undefined && typeof onUpdate !== 'function') throw new Error('onUpdate 必须为函数');
  const synthetic = fixture ? fixtureData() : null;
  const actualHome = fixture ? null : home ?? homedir();
  const pricingPath = configPath ?? (fixture ? null : defaultPricingPath(actualHome));
  const reader = fixture ? null : new ClientTelemetryReader({ home: actualHome, environment: home === undefined ? process.env : {} });
  let catalog = new LocalPriceCatalog(synthetic?.data);
  let pricing = { rules: [] };
  let cached = null;
  let closed = false;
  let timer = null;
  let queue = Promise.resolve();
  let initialized = false;
  let callbackFailed = false;
  let currentWarnings = [];
  const clone = value => structuredClone(value);
  const enqueue = operation => {
    if (closed) return Promise.reject(new Error('后端已关闭'));
    const result = queue.then(() => { if (closed) throw new Error('后端已关闭'); return operation(); });
    queue = result.catch(() => {});
    return result;
  };
  const publish = () => {
    const sources = fixture
      ? Object.fromEntries(SOURCES.map(source => [source, summarize(source, synthetic.records, catalog)]))
      : reader.summaries(catalog, Date.now());
    for (const source of SOURCES) {
      sources[source].warnings.push(...currentWarnings);
      if (fixture) { sources[source].warnings.push('合成演示数据，不代表真实用量或官方价格'); sources[source].fileCount = 0; }
      if (callbackFailed) sources[source].warnings.push('更新回调失败，可主动读取快照');
      const audit = auditSource({ home: actualHome ?? '', source, fileCount: sources[source].fileCount, environment: fixture ? {} : process.env });
      sources[source].channel = audit.channel;
      sources[source].privacyAudit = audit;
      sources[source].availability = sources[source].fileCount > 0 ? 'active' : 'not-configured';
      sources[source].quotaWindows = audit.entitlements.quotaWindows;
      sources[source].balance = audit.entitlements.balance;
      sources[source].plan = audit.entitlements.plan;
      sources[source].planExpiry = audit.entitlements.planExpiry;
    }
    cached = { version: '2.0.0', updatedAt: new Date().toISOString(), fixture, sources };
    if (!closed && onUpdate) {
      try { Promise.resolve(onUpdate(clone(cached))).catch(() => { callbackFailed = true; }); }
      catch { callbackFailed = true; for (const source of SOURCES) cached.sources[source].warnings.push('更新回调失败，可主动读取快照'); }
    }
    return clone(cached);
  };
  const initialize = async () => {
    if (initialized) return;
    initialized = true;
    if (pricingPath) {
      try { pricing = await loadPricing(pricingPath); }
      catch { currentWarnings.push('价格配置读取失败，保留上次生效规则'); }
    }
    catalog.pricing = pricing;
  };
  const refresh = async () => {
    await initialize();
    if (closed) throw new Error('后端已关闭');
    currentWarnings = [];
    if (pricingPath) {
      try { pricing = await loadPricing(pricingPath); }
      catch { currentWarnings.push('价格配置读取失败，保留上次生效规则'); }
    }
    if (!fixture) {
      try { catalog = new LocalPriceCatalog(await readCatalog(join(actualHome, '.ai-yaoce', 'models-dev-cache.json')), pricing); }
      catch { currentWarnings.push('本地价格目录不可读，保留上次目录'); }
      try { await reader.scan(); }
      catch { currentWarnings.push('本批日志采集失败，保留可用计量结果'); }
      if (!timer && !closed) { timer = setInterval(() => { void enqueue(refresh).catch(() => {}); }, 60_000); timer.unref?.(); }
    }
    catalog.pricing = pricing;
    if (closed) throw new Error('后端已关闭');
    return publish();
  };
  return {
    snapshot: () => enqueue(async () => cached ? clone(cached) : refresh()),
    refresh: () => enqueue(refresh),
    getPricing: () => enqueue(async () => { await initialize(); return clone(pricing); }),
    savePricing: value => {
      let validated;
      try { validated = validatePricing(value); } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        await initialize();
        pricing = pricingPath ? await savePricingAtomic(pricingPath, validated) : validated;
        catalog.pricing = pricing;
        if (cached || fixture) publish();
        else await refresh();
        return clone(pricing);
      });
    },
    async close() { closed = true; clearInterval(timer); await queue; },
  };
}
