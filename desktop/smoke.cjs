const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');

async function runDesktopSmoke(window, output) {
  const checks = [];
  const evaluate = async (code) => {
    try { return await window.webContents.executeJavaScript(code, true); }
    catch (error) { throw new Error(`Renderer evaluation failed: ${code.slice(0, 300)}; ${error.message}`); }
  };
  async function waitFor(code, description) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(code)) { checks.push(description); return; }
      await pause(100);
    }
    const state = await evaluate('({text:document.body.innerText, cards:document.querySelectorAll("[data-metric-card]").length, bridge:typeof window.monitor})');
    throw new Error(`Timed out: ${description}; ${JSON.stringify(state)}`);
  }
  async function capture(name) {
    const image = await window.webContents.capturePage();
    assert(!image.isEmpty(), 'Empty desktop screenshot');
    writeFileSync(join(output, name), image.toPNG());
  }

  await waitFor('Boolean(window.monitor && document.querySelectorAll("[data-metric-card]").length >= 4)', 'Renderer and fixture loaded');
  assert.equal(await evaluate('typeof require'), 'undefined');
  assert.equal(await evaluate('typeof process'), 'undefined');
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true);
  checks.push('Renderer sandbox, context isolation and no Node globals');
  const summaries = await evaluate('window.monitor.getSnapshot()');
  assert(summaries.fixture, 'Smoke must never use real telemetry');

  for (const source of ['codex', 'claude', 'zcodex', 'dsh-deepseek', 'qwen-codex', 'kimi-codex']) {
    await evaluate(`document.querySelector('[data-source="${source}"]').click()`);
    await pause(150);
    const sizes = await evaluate(`Array.from(document.querySelectorAll('[data-metric-card]')).map(element => {
      const rect = element.getBoundingClientRect(); return {width: rect.width, height: rect.height, left: rect.left, top: rect.top};
    })`);
    assert(sizes.length >= 4, `Missing cards: ${source}`);
    assert(sizes.every(size => Math.abs(size.width - 150) < 1 && Math.abs(size.height - 128) < 1), `Unequal cards: ${source} ${JSON.stringify(sizes)}`);
    assert.equal(new Set(sizes.map(size => Math.round(size.left))).size, 2, `Not two columns: ${source}`);
    assert(Math.abs(sizes[0].top - sizes[1].top) < 1, `First row not aligned: ${source}`);
    checks.push(`${source}: 150×128 equal cards, two columns`);
    await capture(`${source}.png`);
  }

  await evaluate('document.querySelector("[data-source=codex]").click()');
  const before = await evaluate('window.monitor.getPricing()');
  assert.equal(before.rules.length, 0, 'Fixture config must start empty');
  await evaluate('document.querySelector("#settings-toggle").click()');
  await waitFor('Boolean(document.querySelector("#add-rule") && !document.querySelector("#pricing-fields").disabled)', 'Pricing rule list opened');
  await evaluate('document.querySelector("#add-rule").click()');
  await waitFor('Boolean(document.querySelector("#rule-model"))', 'Pricing settings opened');
  const model = summaries.sources.codex.models[0].id;
  await evaluate(`(() => {
    const values = ${JSON.stringify({ 'rule-source': 'codex', 'rule-provider': '', 'rule-model': model, 'rule-alias': '', 'rule-input': '0', 'rule-output': '0', 'rule-cache-read': '0', 'rule-cache-write': '0' })};
    for (const [id, value] of Object.entries(values)) {
      const element = document.getElementById(id);
      if (!element) throw new Error('Missing field: ' + id);
      element.value = value; element.dispatchEvent(new Event('input', {bubbles:true})); element.dispatchEvent(new Event('change', {bubbles:true}));
    }
    document.getElementById('save-rule').click();
  })()`);
  await waitFor('(async () => (await window.monitor.getPricing()).rules.length === 1)()', 'Pricing form persisted a zero-price rule');
  const saved = await evaluate('window.monitor.getPricing()');
  assert.equal(saved.rules[0].prices.input, 0);
  assert.equal(saved.rules[0].prices.output, 0);
  await evaluate('window.monitor.refresh()');
  const after = await evaluate('window.monitor.getSnapshot()');
  assert(after.sources.codex.manualRecords > 0, 'History did not use custom prices');
  assert(after.sources.codex.estimatedUSD <= summaries.sources.codex.estimatedUSD, 'Zero price increased cost');
  checks.push('Historical usage repriced through UI + IPC + worker');
  await evaluate('document.querySelector("#settings-toggle").click()');
  await pause(150);
  await capture('pricing.png');
  await evaluate('document.querySelector("#rule-alias").value = "未保存草稿"');
  await evaluate('window.monitor.refresh()');
  assert.equal(await evaluate('document.querySelector("#rule-alias").value'), '未保存草稿');
  checks.push('Background updates do not overwrite pricing drafts');

  let rejected = false;
  try { await evaluate(`window.monitor.savePricing({rules:[{source:'codex',provider:'',model:'invalid',alias:'',prices:{input:-1}}]})`); }
  catch { rejected = true; }
  assert(rejected, 'Negative price accepted by backend');
  assert.equal((await evaluate('window.monitor.getPricing()')).rules.length, 1, 'Rejected save changed config');
  checks.push('Invalid price rejected across IPC without overwriting rules');

  await evaluate(`document.querySelector('[data-rule-index="0"] [data-action="delete-rule"]').click(); document.querySelector('#save-rule').click()`);
  await waitFor('(async () => (await window.monitor.getPricing()).rules.length === 0)()', 'Pricing delete saved through the UI');
  const restored = await evaluate('window.monitor.getSnapshot()');
  assert.equal(restored.sources.codex.estimatedUSD, summaries.sources.codex.estimatedUSD, 'Default pricing not restored');
  checks.push('Deleting rules restored default historical pricing');

  await evaluate('window.monitor.setAlwaysOnTop(true)');
  assert(window.isAlwaysOnTop(), 'Always-on-top did not enable');
  await evaluate('window.monitor.setAlwaysOnTop(false)');
  assert(!window.isAlwaysOnTop(), 'Always-on-top did not disable');
  checks.push('Native always-on-top toggle');

  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await loaded;
  await waitFor('Boolean(document.querySelectorAll("[data-metric-card]").length >= 4)', 'Page reload restored the monitor');
  const reloaded = await evaluate('window.monitor.getPricing()');
  assert.equal(reloaded.rules.length, 0);
  assert.equal(await evaluate('document.querySelector("[data-source][aria-selected=true]").dataset.source'), 'codex');
  checks.push('Saved pricing remained consistent after reload');
  checks.push('Source selection persisted after reload');
  await evaluate('document.querySelector("#theme-toggle").click()');
  await pause(150);
  await capture('theme-alternate.png');
  checks.push('Alternate theme rendered');
  await evaluate(`(() => {
    document.documentElement.dataset.theme = 'dark';
    const select = document.createElement('select');
    const option = document.createElement('option');
    option.textContent = '深色菜单可读性'; select.append(option); document.body.append(select);
    const foreground = getComputedStyle(option).color;
    const background = getComputedStyle(option).backgroundColor;
    if (foreground !== 'rgb(224, 228, 237)' || background !== 'rgb(39, 43, 54)') throw new Error('Dark option palette mismatch');
    if (getComputedStyle(select).backgroundColor !== background) throw new Error('Closed select palette mismatch');
    select.remove();
  })()`);
  checks.push('Dark dropdown explicit foreground and opaque background');

  const empty = structuredClone(summaries);
  empty.sources.codex = { source: 'codex', models: [], warnings: ['未发现可用日志'], providers: [], fileCount: 0 };
  window.webContents.send('monitor:update', empty);
  await pause(150);
  assert.equal(await evaluate('document.querySelectorAll("[data-metric-card]").length'), 4);
  await capture('empty.png');
  checks.push('Empty source kept four equal cards');
  const longNames = structuredClone(summaries);
  longNames.sources.codex.models[0].id = 'relay-model-' + '超长别名'.repeat(50);
  window.webContents.send('monitor:update', longNames);
  await pause(150);
  assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Long model name caused horizontal overflow');
  await capture('long-model.png');
  checks.push('Long model names do not widen the panel');
  await waitFor('Boolean(document.querySelector("#health-save"))', 'Health settings loaded');
  const health = await evaluate('window.monitor.getHealth()');
  assert.equal(health.config.enabled, false);
  assert.equal(health.config.interval, 600);
  assert.equal(health.stats.requests, 0);
  await evaluate(`document.querySelector('#settings-toggle').click(); document.querySelector('#health-interval').value='900'; document.querySelector('#health-save').click()`);
  await waitFor('(async () => (await window.monitor.getHealth()).config.interval === 900)()', 'Health interval saved from UI');
  await evaluate(`window.monitor.saveHealth({...${JSON.stringify(health.config)}, targets:[{id:'fixture',source:'fixture',model:'mock',endpoint:'https://example.test/v1/chat/completions',protocol:'chat',apiKey:'test-fixture-key',enabled:true,reasoning:false}]})`);
  const savedHealth = await evaluate('window.monitor.getHealth()');
  assert.equal(savedHealth.config.targets[0].hasKey, true);
  assert(!JSON.stringify(savedHealth).includes('test-fixture-key'));
  assert.equal(savedHealth.stats.requests, 0);
  checks.push('Health key never echoed and disabled detection never requested');
  assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Health form caused horizontal overflow');
  await capture('health-settings.png');
  checks.push('Health settings fit narrow panel');
  return { passed: true, checks, count: checks.length };
}

module.exports = { runDesktopSmoke };
