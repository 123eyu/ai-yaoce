(() => {
  'use strict';
  const bridge = window.monitor;
  const sources = ['codex', 'claude', 'zcodex', 'dsh-deepseek', 'qwen-codex', 'kimi-codex'];
  const sourceNames = { codex: 'Codex', claude: 'Claude Code', zcodex: 'zCodex', 'dsh-deepseek': 'DSH DeepSeek', 'qwen-codex': 'Qwen Codex', 'kimi-codex': 'Kimi Codex' };
  const priceKeys = ['input', 'output', 'cache_read', 'cache_write'];
  const byId = (id) => document.getElementById(id);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const count = (value) => finite(value) ? value.toLocaleString('zh-CN') : '—';
  const money = (value) => finite(value) ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : '—';
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch { status('本地偏好无法保存，本次仍可使用。'); } };
  let selectedSource = sources.includes(read('monitor.source')) ? read('monitor.source') : 'codex';
  let snapshot = null;
  let pinned = false;
  let saving = false;
  let pricingLoaded = false;
  let pricingLoading = false;
  let unsubscribe;
  let snapshotRevision = 0;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function status(message) {
    byId('app-status').textContent = message;
    byId('app-status').hidden = !message;
  }

  function dateText(value) {
    if (value === null || value === undefined || value === '') return '尚未更新';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
  }

  function card(key, label, value, details = []) {
    const element = node('article');
    element.dataset.metricCard = key;
    const heading = node('div', 'metric-label', label);
    heading.title = label;
    const metric = node('div', 'metric-value', value);
    metric.title = value;
    element.append(heading, metric);
    for (const detail of details) {
      const line = node('div', 'metric-detail', detail);
      line.title = detail;
      element.append(line);
    }
    return element;
  }

  function quotaCard(windowQuota, index) {
    const quota = windowQuota || {};
    const known = finite(quota.usedPercent);
    const element = card(`quota-${quota.name || index}`, quota.label || quota.name || '额度窗口', known ? `${quota.precision === 'exact' ? '' : '≈'}${quota.usedPercent.toFixed(1)}%` : '—');
    if (known) {
      const progress = node('progress');
      progress.max = 100;
      progress.value = Math.min(100, quota.usedPercent);
      progress.setAttribute('aria-label', '已用额度');
      element.append(progress);
    }
    const cost = quota.cost || {};
    const details = [
      known ? `已用 · 剩余 ${Math.max(0, 100 - quota.usedPercent).toFixed(1)}%` : '额度口径未知',
      finite(quota.usedPoints) ? `${count(quota.usedPoints)} / ${count(quota.budgetPoints)} 点` : `${money(cost.spentUSD)} / ${money(cost.fullUSD)} 等效美元`,
      quota.resetAt ? `重置 ${dateText(quota.resetAt)}` : '重置时间未知'
    ];
    for (const text of details) {
      const detail = node('div', 'metric-detail', text);
      detail.title = text;
      element.append(detail);
    }
    return element;
  }

  function render() {
    const summary = snapshot?.sources?.[selectedSource];
    const grid = byId('metric-grid');
    grid.replaceChildren();
    const quotas = Array.isArray(summary?.quotaWindows) ? summary.quotaWindows : [];
    if (quotas.length) {
      quotas.forEach((quota, index) => grid.append(quotaCard(quota, index)));
    } else {
      grid.append(
        card('today-tokens', '今日用量 · tokens', count(summary?.todayTokens), [`${count(summary?.todayRecords)} 条记录`, '当前来源 · 不与其他来源合并']),
        card('week-tokens', '近7天用量 · tokens', count(summary?.weekTokens), [`${count(summary?.weekRecords)} 条记录`, '滚动近7天累计']),
        card('month-tokens', '本月用量 · tokens', count(summary?.monthTokens), ['当月累计 · 非剩余额度']),
        card('estimated-usd', '今日估算 · USD', finite(summary?.pricedRecords) && summary.pricedRecords > 0 ? money(summary.estimatedUSD) : '—', [`未计价 ${count(summary?.unpricedRecords)} 条`, `本月 ${finite(summary?.monthTokens) && summary.monthTokens > 0 && finite(summary?.monthUnpricedRecords) && summary.monthUnpricedRecords === 0 ? money(summary?.monthEstimatedUSD) : '见计价说明'}`])
      );
    }
    const entitlement = [
      summary?.balance !== null && summary?.balance !== undefined ? `余额 ${summary.balance}` : '',
      summary?.plan ? `套餐 ${summary.plan}` : '',
      summary?.planExpiry ? `到期 ${dateText(summary.planExpiry)}` : '',
    ].filter(Boolean).join(' · ');
    byId('quota-note').textContent = quotas.length ? `${sourceNames[selectedSource]} 本地读取到的额度窗口；没有本地证据的官方信息不显示。${entitlement ? ` ${entitlement}` : ''}` : `${sourceNames[selectedSource]} 仅显示本地可读取的用量，不推算剩余额度。${entitlement ? ` ${entitlement}` : ''}`;
    const models = byId('model-list');
    models.replaceChildren();
    const rows = Array.isArray(summary?.models) ? summary.models : [];
    for (const model of rows) {
      const item = node('li');
      item.append(node('span', 'model-name', model.id || '未知模型'), node('span', 'model-usage', `${count(model.tokens)} tokens · ${count(model.count)} 条记录`));
      models.append(item);
    }
    if (!rows.length) models.append(node('li', 'note', '暂无模型记录；未生成模拟用量。'));
    const providers = Array.isArray(summary?.providers) ? summary.providers.join('、') : '';
    byId('source-details').textContent = `${count(summary?.fileCount)} 个日志文件${providers ? ` · ${providers}` : ''}${summary?.latest ? ` · 最近记录 ${dateText(summary.latest)}` : ''}`;
    byId('pricing-note').textContent = `默认价目表估算；匹配手动规则时优先使用手动单价，空项继承别名或默认价。今日已计价 ${count(summary?.pricedRecords)} 条，其中手动 ${count(summary?.manualRecords)} 条，未计价 ${count(summary?.unpricedRecords)} 条。本月未计价 ${count(summary?.monthUnpricedRecords)} 条；未计价记录不计入金额，估算非实付账单。${finite(summary?.monthEstimatedUSD) && finite(summary?.monthTokens) && summary.monthTokens > 0 ? `本月已计价部分：${money(summary.monthEstimatedUSD)}。` : ''}`;
    const channelNames = { 'official-subscription': '官方订阅', 'official-api': '官方 API', relay: '中转', unknown: '无法确定', 'not-configured': '未配置' };
    const audit = summary?.privacyAudit ?? {};
    byId('privacy-channel').textContent = `渠道：${channelNames[summary?.channel] ?? '无法确定'} · 证据可信度：${audit.confidence ?? 'low'}。未发现证据不等于绝对没有上传。`;
    byId('privacy-audit').replaceChildren(...(Array.isArray(audit.items) ? audit.items : []).map(item => node('li', '', `${item.label}：${item.value} · ${item.confidence}`)));
    const warnings = Array.isArray(summary?.warnings) ? summary.warnings : [];
    byId('warnings').replaceChildren(...warnings.map((warning) => node('li', '', warning)));
    byId('warnings-section').hidden = warnings.length === 0;
    byId('updated-at').textContent = dateText(snapshot?.updatedAt);
    byId('fixture-label').hidden = !snapshot?.fixture;
    byId('connection-state').textContent = summary ? `${sourceNames[selectedSource]} · 本地统计` : `${sourceNames[selectedSource]} · 暂无数据`;
  }

  function acceptSnapshot(value) {
    if (!value || typeof value !== 'object' || !value.sources) throw new Error('本地快照格式不完整');
    snapshot = value;
    snapshotRevision += 1;
    render();
  }

  async function loadSnapshot(method) {
    const revision = snapshotRevision;
    const value = await bridge[method]();
    if (revision === snapshotRevision) acceptSnapshot(value);
  }

  function selectSource(source, focus = false) {
    selectedSource = source;
    store('monitor.source', source);
    for (const tab of document.querySelectorAll('[data-source]')) {
      const selected = tab.dataset.source === source;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    byId('source-panel').setAttribute('aria-labelledby', `tab-${source}`);
    render();
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    byId('theme-toggle').setAttribute('aria-pressed', String(theme === 'dark'));
    byId('theme-toggle').title = theme === 'dark' ? '切换浅色主题' : '切换深色主题';
  }

  function activateRule(item, focus = true) {
    for (const input of byId('pricing-rules').querySelectorAll('[id]')) input.removeAttribute('id');
    for (const row of byId('pricing-rules').querySelectorAll('[data-pricing-rule]')) {
      row.dataset.editing = String(row === item);
      row.querySelector('.rule-grid').hidden = row !== item;
      row.querySelector('[data-action="edit-rule"]').setAttribute('aria-expanded', String(row === item));
    }
    for (const input of item.querySelectorAll('[name]')) input.id = `rule-${input.name.replaceAll('_', '-')}`;
    if (focus) item.querySelector('[name="model"]').focus();
  }

  function indexRules() {
    byId('pricing-rules').querySelectorAll('[data-pricing-rule]').forEach((item, index) => { item.dataset.ruleIndex = String(index); });
  }

  function addRule(rule = {}) {
    const item = node('fieldset', 'pricing-rule');
    item.dataset.pricingRule = '';
    const heading = node('div', 'rule-heading');
    const title = node('strong', 'rule-title', rule.model || '新规则');
    title.title = rule.model || '新规则';
    heading.append(title);
    const edit = node('button', '', '编辑');
    edit.type = 'button';
    edit.dataset.action = 'edit-rule';
    edit.addEventListener('click', () => activateRule(item));
    heading.append(edit);
    const remove = node('button', '', '删除');
    remove.type = 'button';
    remove.dataset.action = 'delete-rule';
    remove.setAttribute('aria-label', '删除此计价规则');
    remove.addEventListener('click', () => {
      const active = item.dataset.editing === 'true';
      item.remove();
      indexRules();
      const next = byId('pricing-rules').querySelector('[data-pricing-rule]');
      if (active && next) activateRule(next);
      else byId('add-rule').focus();
      byId('pricing-status').textContent = '规则已从草稿删除；保存后生效。';
    });
    heading.append(remove);
    const fields = node('div', 'rule-grid');
    const definitions = [['source', '来源'], ['provider', 'Provider · 可空'], ['model', 'Model · 必填'], ['alias', 'Alias · 计价别名，可空'], ['input', 'Input'], ['output', 'Output'], ['cache_read', 'Cache read'], ['cache_write', 'Cache write']];
    for (const [key, fieldTitle] of definitions) {
      const label = node('label', key === 'model' || key === 'alias' ? 'full-width' : '', fieldTitle);
      const input = node(key === 'source' ? 'select' : 'input');
      input.name = key;
      if (key === 'source') {
        for (const source of sources) {
          const option = node('option', '', sourceNames[source]);
          option.value = source;
          input.append(option);
        }
      } else {
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
      }
      if (priceKeys.includes(key)) {
        input.inputMode = 'decimal';
        input.placeholder = '继承';
        input.value = rule.prices?.[key] ?? '';
      } else input.value = rule[key] ?? (key === 'source' ? selectedSource : '');
      if (key === 'model') input.addEventListener('input', () => {
        title.textContent = input.value || '新规则';
        title.title = input.value || '新规则';
      });
      label.append(input);
      fields.append(label);
    }
    item.append(heading, fields);
    byId('pricing-rules').append(item);
    indexRules();
    activateRule(item, false);
    return item;
  }

  function collectRules() {
    const identities = new Set();
    return Array.from(document.querySelectorAll('[data-pricing-rule]'), (item, index) => {
      const field = (key) => item.querySelector(`[name="${key}"]`);
      const invalid = (key, message) => {
        activateRule(item, false);
        field(key).setAttribute('aria-invalid', 'true');
        field(key).focus();
        throw new Error(`规则 ${index + 1}：${message}`);
      };
      item.querySelectorAll('[aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
      const rule = { source: field('source').value, provider: field('provider').value.trim(), model: field('model').value.trim(), alias: field('alias').value.trim(), prices: {} };
      if (!sources.includes(rule.source)) invalid('source', '请选择有效来源');
      if (!rule.model) invalid('model', 'Model 不能为空');
      const identity = JSON.stringify([rule.source, rule.provider, rule.model]);
      if (identities.has(identity)) invalid('model', '来源、Provider 和 Model 组合重复');
      identities.add(identity);
      for (const key of priceKeys) {
        const raw = field(key).value.trim();
        if (!raw) continue;
        const value = Number(raw);
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !finite(value) || value > 1000000) invalid(key, `${key} 须为 0～1000000 的有限数字，或留空继承`);
        rule.prices[key] = value;
      }
      return rule;
    });
  }

  async function showSettings() {
    byId('source-panel').hidden = true;
    byId('source-tabs').hidden = true;
    byId('settings-panel').hidden = false;
    byId('settings-toggle').setAttribute('aria-expanded', 'true');
    if (pricingLoaded || pricingLoading) return;
    pricingLoading = true;
    byId('pricing-fields').disabled = true;
    byId('save-rule').disabled = true;
    byId('pricing-status').textContent = '读取本地价格规则…';
    try {
      const value = await bridge.getPricing();
      if (!Array.isArray(value?.rules)) throw new Error('价格规则格式不完整');
      byId('pricing-rules').replaceChildren();
      value.rules.forEach(addRule);
      const first = byId('pricing-rules').querySelector('[data-pricing-rule]');
      if (first) activateRule(first, false);
      pricingLoaded = true;
      byId('pricing-status').textContent = value.rules.length ? '编辑后保存将重算历史记录。' : '暂无手动规则，当前使用默认计价。';
    } catch (error) { byId('pricing-status').textContent = `读取失败：${error.message}。关闭后重新打开可重试。`; }
    finally {
      pricingLoading = false;
      byId('pricing-fields').disabled = !pricingLoaded;
      byId('save-rule').disabled = !pricingLoaded;
    }
  }

  function hideSettings() {
    if (saving) return;
    byId('settings-panel').hidden = true;
    byId('source-panel').hidden = false;
    byId('source-tabs').hidden = false;
    byId('settings-toggle').setAttribute('aria-expanded', 'false');
    byId(`tab-${selectedSource}`).focus();
  }

  byId('pricing-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || !pricingLoaded) return;
    let rules;
    try { rules = collectRules(); }
    catch (error) { byId('pricing-status').textContent = error.message; return; }
    saving = true;
    byId('pricing-fields').disabled = true;
    byId('save-rule').disabled = true;
    byId('settings-back').disabled = true;
    byId('settings-toggle').disabled = true;
    let saved = false;
    let refreshed = false;
    try {
      await bridge.savePricing({ rules });
      saved = true;
      await loadSnapshot('refresh');
      refreshed = true;
    } catch (error) { byId('pricing-status').textContent = `${saved ? '规则已保存，但历史刷新失败' : '保存失败，草稿已保留'}：${error.message}`; }
    finally {
      saving = false;
      byId('pricing-fields').disabled = false;
      byId('save-rule').disabled = false;
      byId('settings-back').disabled = false;
      byId('settings-toggle').disabled = false;
    }
    if (refreshed) { byId('pricing-status').textContent = '已保存。'; hideSettings(); status('价格规则已保存，历史统计已刷新。'); }
  });
  byId('add-rule').addEventListener('click', () => addRule().querySelector('[name="model"]').focus());
  byId('settings-toggle').addEventListener('click', () => byId('settings-panel').hidden ? showSettings() : hideSettings());
  byId('settings-back').addEventListener('click', hideSettings);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !byId('settings-panel').hidden) hideSettings(); });
  for (const tab of document.querySelectorAll('[data-source]')) {
    tab.addEventListener('click', () => selectSource(tab.dataset.source));
    tab.addEventListener('keydown', (event) => {
      const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!offset && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? sources.length - 1 : (sources.indexOf(selectedSource) + offset + sources.length) % sources.length;
      selectSource(sources[index], true);
    });
  }
  byId('theme-toggle').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(theme);
    store('monitor.theme', theme);
  });
  byId('refresh-button').addEventListener('click', async () => {
    byId('refresh-button').disabled = true;
    try { await loadSnapshot('refresh'); status('已刷新本地统计。'); }
    catch (error) { status(`刷新失败：${error.message}`); }
    finally { byId('refresh-button').disabled = false; }
  });
  byId('pin-toggle').addEventListener('click', async () => {
    byId('pin-toggle').disabled = true;
    try {
      const value = await bridge.setAlwaysOnTop(!pinned);
      pinned = typeof value === 'boolean' ? value : !pinned;
      byId('pin-toggle').setAttribute('aria-pressed', String(pinned));
      byId('pin-toggle').title = pinned ? '取消置顶' : '置顶';
    } catch (error) { status(`置顶失败：${error.message}`); }
    finally { byId('pin-toggle').disabled = false; }
  });
  for (const method of ['minimize', 'close']) byId(`${method}-button`).addEventListener('click', async () => {
    try { await bridge[method](); } catch (error) { status(`窗口操作失败：${error.message}`); }
  });
  setTheme(['light', 'dark'].includes(read('monitor.theme')) ? read('monitor.theme') : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  selectSource(selectedSource);
  if (!bridge) {
    status('桌面桥未连接；请从桌面应用打开。');
    for (const id of ['refresh-button', 'pin-toggle', 'minimize-button', 'close-button', 'settings-toggle']) byId(id).disabled = true;
    return;
  }
  try {
    unsubscribe = bridge.onSnapshot((value) => { try { acceptSnapshot(value); } catch (error) { status(error.message); } });
  } catch (error) { status(`自动更新不可用：${error.message}`); }
  window.addEventListener('beforeunload', () => { if (typeof unsubscribe === 'function') unsubscribe(); });
  loadSnapshot('getSnapshot').catch((error) => status(`读取失败：${error.message}`));
})();
