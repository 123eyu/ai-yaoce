import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SOURCES } from './source-registry.mjs';

export { SOURCES } from './source-registry.mjs';

export const PRICE_KEYS = ['input', 'output', 'cache_read', 'cache_write'];
export const defaultPricingPath = home => process.platform === 'darwin'
  ? join(home, 'Library', 'Application Support', 'ai-yaoce', 'pricing-rules.json')
  : join(home, ...(process.platform === 'win32' ? ['AppData', 'Roaming', 'ai-yaoce'] : ['.ai-yaoce']), 'pricing-rules.json');

export function validatePricing(value) {
  if (!value || !Array.isArray(value.rules)) throw new Error('价格配置必须包含 rules 数组');
  const identities = new Set();
  const rules = value.rules.map(rule => {
    if (!rule || !SOURCES.includes(rule.source) || typeof rule.model !== 'string' || !rule.model.length ||
        typeof rule.provider !== 'string' || typeof rule.alias !== 'string' ||
        !rule.prices || typeof rule.prices !== 'object' || Array.isArray(rule.prices)) {
      throw new Error('价格规则无效：来源、模型、提供商、别名或价格格式错误');
    }
    const identity = JSON.stringify([rule.source, rule.provider, rule.model]);
    if (identities.has(identity)) throw new Error('价格规则重复');
    identities.add(identity);
    const prices = {};
    for (const [key, price] of Object.entries(rule.prices)) {
      if (!PRICE_KEYS.includes(key) || typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1e6) {
        throw new Error('单价须为 0～1000000 的有限数字；空字段请省略');
      }
      prices[key] = price;
    }
    return { source: rule.source, provider: rule.provider, model: rule.model, alias: rule.alias, prices };
  });
  return { rules };
}

export async function loadPricing(path) {
  try { return validatePricing(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { rules: [] }; throw new Error('价格配置读取失败，保留上次生效规则'); }
}

export async function savePricingAtomic(path, value) {
  const pricing = validatePricing(value);
  const directory = dirname(path);
  const temporary = join(directory, `.pricing-${randomUUID()}.tmp`);
  let handle;
  try {
    await mkdir(directory, { recursive: true });
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(pricing, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch {
    throw new Error('价格配置原子保存失败，原规则未替换');
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
  return pricing;
}

export function matchRule(pricing, source, provider, model) {
  const candidates = pricing.rules.filter(rule => rule.source === source && rule.model === model);
  return candidates.find(rule => rule.provider && rule.provider === provider) ?? candidates.find(rule => !rule.provider);
}

export function estimateTokens(prices, tokens) {
  let result = 0;
  for (const [key, count] of [['input', tokens.input], ['output', tokens.output], ['cache_read', tokens.cached], ['cache_write', tokens.written]]) {
    if (!(count > 0)) continue;
    if (!Number.isFinite(prices[key]) || prices[key] < 0) return null;
    result += count * prices[key] / 1e6;
  }
  return Number.isFinite(result) ? result : null;
}

export class LocalPriceCatalog {
  constructor(data = {}, pricing = { rules: [] }) {
    this.pricing = validatePricing(pricing);
    this.rates = new Map();
    for (const [provider, value] of Object.entries(data?.data ?? {})) {
      for (const [model, detail] of Object.entries(value?.models ?? {})) {
        const rate = {};
        for (const key of PRICE_KEYS) {
          const number = detail?.cost?.[key];
          if (typeof number === 'number' && Number.isFinite(number) && number >= 0) rate[key] = number;
        }
        this.rates.set(JSON.stringify([provider.toLowerCase(), model]), rate);
      }
    }
  }
  defaultRate(provider, model) {
    const canonical = provider.toLowerCase().replace(/-(responses|chat|completions|messages)$/, '');
    const manufacturer = model.startsWith('claude-') ? 'anthropic' : /^(gpt-|o3|o4)/.test(model) ? 'openai' : model.startsWith('gemini-') ? 'google' : model.startsWith('deepseek-') ? 'deepseek' : null;
    return this.rates.get(JSON.stringify([canonical, model])) ?? this.rates.get(JSON.stringify([manufacturer, model])) ?? {};
  }
  resolve(source, provider, model) {
    const rule = matchRule(this.pricing, source, provider, model);
    return { ...this.defaultRate(provider, rule?.alias || model), ...rule?.prices };
  }
  estimate(record) {
    if (record.priceUnsupported || !(Object.values(record.tokens).reduce((sum, count) => sum + count, 0) > 0)) return null;
    return estimateTokens(this.resolve(record.source, record.provider, record.model), record.tokens);
  }
}
