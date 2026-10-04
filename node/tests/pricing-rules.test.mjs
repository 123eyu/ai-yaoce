import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPriceCatalog, validatePricing, matchRule, estimateTokens, loadPricing, savePricingAtomic } from '../pricing-rules.mjs';

const rule = (overrides = {}) => ({ source: 'codex', provider: '', model: 'relay-model', alias: '', prices: {}, ...overrides });
const catalogData = { data: { openai: { models: { 'gpt-test': { cost: { input: 2, output: 8, cache_read: 0 } } } } } };

test('price validation rejects malformed, duplicate and unsafe rules, preserves zero', () => {
  assert.deepEqual(validatePricing({ rules: [rule({ prices: { input: 0 } })] }).rules[0].prices, { input: 0 });
  for (const value of [null, {}, { rules: [rule(), rule()] }, { rules: [rule({ source: 'other' })] }, { rules: [rule({ model: '' })] },
    ...[-1, NaN, Infinity, 1000001, '2', null, ''].map(input => ({ rules: [rule({ prices: { input } })] })),
    { rules: [rule({ prices: { unknown: 1 } })] }, { rules: [rule({ provider: null })] }]) assert.throws(() => validatePricing(value));
});

test('matching is source isolated, exact provider beats wildcard; alias inherits only known prices', () => {
  const pricing = { rules: [rule({ alias: 'gpt-test', prices: { input: 0 } }), rule({ provider: 'relay', prices: { input: 7 } })] };
  const catalog = new LocalPriceCatalog(catalogData, pricing);
  assert.equal(matchRule(pricing, 'codex', 'relay', 'relay-model').prices.input, 7);
  assert.equal(matchRule(pricing, 'claude', 'relay', 'relay-model'), undefined);
  assert.deepEqual(catalog.resolve('codex', 'other', 'relay-model'), { input: 0, output: 8, cache_read: 0 });
  assert.deepEqual(catalog.resolve('claude', 'other', 'relay-model'), {});
  assert.deepEqual(catalog.defaultRate('openai-responses', 'gpt-test'), { input: 2, output: 8, cache_read: 0 });
  assert.deepEqual(catalog.defaultRate('relay', 'gpt-test'), { input: 2, output: 8, cache_read: 0 });
  assert.deepEqual(catalog.defaultRate('openai', 'gpt-test-new'), {});
});

test('zero, missing cache price and hourly cache are not guessed', () => {
  assert.equal(estimateTokens({ input: 0 }, { input: 200, cached: 0, written: 0, output: 0 }), 0);
  assert.equal(estimateTokens({ input: 1 }, { input: 200, cached: 1, written: 0, output: 0 }), null);
  assert.equal(estimateTokens({ input: 1 }, { input: 200, cached: 0, written: 0, output: 0 }), 0.0002);
  const catalog = new LocalPriceCatalog(catalogData);
  assert.equal(catalog.estimate({ source: 'codex', provider: 'openai', model: 'gpt-test', tokens: { input: 1, cached: 0, written: 0, output: 0 }, priceUnsupported: true }), null);
});

test('atomic persistence validates before writing, retains original on failure, removes temporary file', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'mirasim-pricing-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'rules.json');
  assert.deepEqual(await loadPricing(path), { rules: [] });
  const original = { rules: [rule({ prices: { input: 0 } })] };
  await savePricingAtomic(path, original);
  await assert.rejects(savePricingAtomic(path, { rules: [rule({ prices: { input: -1 } })] }));
  assert.deepEqual(await loadPricing(path), original);
  const blocked = join(directory, 'directory.json'); await mkdir(blocked);
  await assert.rejects(savePricingAtomic(blocked, original), /原子保存失败/);
  assert.deepEqual((await readdir(directory)).sort(), ['directory.json', 'rules.json']);
  await writeFile(path, 'broken SECRET');
  await assert.rejects(loadPricing(path), error => !error.message.includes('SECRET'));
});
