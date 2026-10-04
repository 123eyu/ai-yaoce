(() => {
  const panel = document.querySelector('#health-panel');
  let draft;
  let status;
  let results;
  let busy = false;
  const element = (tag, text, parent) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (parent) parent.append(node);
    return node;
  };
  const field = (parent, label, value, type = 'text') => {
    const wrap = element('label', label, parent);
    const input = element('input', '', wrap);
    input.type = type;
    if (type === 'checkbox') input.checked = value; else input.value = value ?? '';
    input.autocomplete = 'off';
    return input;
  };
  const button = (parent, label, action) => {
    const node = element('button', label, parent); node.type = 'button';
    node.onclick = async () => {
      if (busy) return;
      try { await action(); } catch { status.textContent = '操作失败：请检查参数、重复模型或加密存储权限'; }
    };
    return node;
  };
  function render(snapshot) {
    draft = snapshot.config;
    panel.replaceChildren();
    element('h2', '模型可用性监测', panel);
    element('p', '仅在应用运行时检测，开启会联网并可能收费。不携带历史或工具；预算不足标记“未确认”，不会自动加价重试。', panel).className = 'note';
    const form = element('div', '', panel); form.className = 'health-fields';
    const enabled = field(form, '启用检测（保存后生效）', draft.enabled, 'checkbox');
    enabled.id = 'health-enabled';
    const interval = field(form, '间隔（秒，10～86400）', draft.interval, 'number'); interval.id = 'health-interval';
    const timeout = field(form, '超时（秒，1～300）', draft.timeout, 'number');
    const prompt = field(form, '测试口令', draft.prompt); prompt.id = 'health-prompt';
    const tokens = field(form, '输出token上限（1～4096）', draft.maxTokens, 'number');
    element('p', '模型数量不限，最多同时检测2个。低推理选项仅适用于支持该参数的模型。', panel).className = 'note';
    const list = element('div', '', panel);
    function targets() {
      list.replaceChildren();
      for (const target of draft.targets) {
        const card = element('div', '', list); card.className = 'health-target';
        element('strong', `${target.source || '未命名线路'} · ${target.model}`, card);
        element('p', `${target.protocol} · ${target.endpoint}`, card).className = 'note';
        const toggle = field(card, '启用此模型', target.enabled, 'checkbox'); toggle.onchange = () => { target.enabled = toggle.checked; };
        button(card, '删除', () => { draft.targets = draft.targets.filter(item => item !== target); targets(); });
      }
    }
    targets();
    const add = element('div', '', panel); add.className = 'health-fields';
    element('h3', '添加线路与模型', add);
    const source = field(add, '来源 / 账号标签', '');
    const endpoint = field(add, '完整请求URL（含接口路径）', '', 'url'); endpoint.placeholder = 'https://example.com/v1/chat/completions';
    const protocolLabel = element('label', '协议', add);
    const protocol = element('select', '', protocolLabel);
    for (const [value, text] of [['chat', 'Chat Completions'], ['responses', 'Responses'], ['anthropic', 'Anthropic Messages']]) {
      const option = element('option', text, protocol); option.value = value;
    }
    const key = field(add, 'API Key（不会回显，系统加密保存）', '', 'password');
    const modelLabel = element('label', '模型ID（一行一个，可批量）', add);
    const models = element('textarea', '', modelLabel); models.rows = 3;
    const reasoning = field(add, '低推理模式（Chat / Responses）', false, 'checkbox');
    const inputPrice = field(add, '输入单价 USD / 百万token（空=未知）', '', 'number');
    const outputPrice = field(add, '输出单价 USD / 百万token（空=未知）', '', 'number');
    button(add, '添加到待保存列表', () => {
      const names = models.value.split('\n').map(name => name.trim()).filter(Boolean);
      if (!names.length) throw Error('empty');
      for (const model of names) draft.targets.push({ source: source.value, endpoint: endpoint.value, protocol: protocol.value,
        apiKey: key.value, model, enabled: true, reasoning: reasoning.checked,
        inputPrice: inputPrice.value.trim() ? Number(inputPrice.value) : null,
        outputPrice: outputPrice.value.trim() ? Number(outputPrice.value) : null });
      key.value = ''; models.value = ''; targets(); status.textContent = '已加入列表，请保存生效';
    });
    status = element('p', snapshot.storageError || '', panel); status.setAttribute('role', 'status'); status.id = 'health-status';
    const actions = element('div', '', panel); actions.className = 'settings-actions';
    const save = button(actions, '保存检测设置', async () => {
      busy = true; save.disabled = true;
      try {
        const saved = await window.monitor.saveHealth({ ...draft, enabled: enabled.checked, interval: Number(interval.value), timeout: Number(timeout.value), prompt: prompt.value, maxTokens: Number(tokens.value) });
        render(saved); status.textContent = '检测设置已保存';
      } finally { busy = false; save.disabled = false; }
    });
    save.id = 'health-save'; save.disabled = Boolean(snapshot.storageError);
    button(actions, '立即检测已保存模型', async () => { await window.monitor.checkHealth(); await refresh(); });
    element('p', '以下仅统计本次运行的探测用量，费用按手填单价估算，非账单。中转自身日志若记录探测，普通遥测统计仍可能包含。修改已有线路请删除后重新添加。', panel).className = 'note';
    results = element('div', '', panel); results.id = 'health-results';
    showResults(snapshot);
  }
  function showResults(snapshot) {
    results.replaceChildren();
    const stats = snapshot.stats;
    element('p', `${snapshot.config.enabled ? '检测已启用' : '检测已关闭'} · ${stats.requests}次 · 输入${stats.input} / 输出${stats.output} tokens · 估算$${stats.estimatedUSD.toFixed(6)} · 用量未知${stats.unknownUsage}次 / 费用未知${stats.unpriced}次`, results).className = 'note';
    for (const target of snapshot.config.targets) {
      const result = snapshot.results[target.id];
      const row = element('div', '', results); row.className = 'health-target';
      element('strong', `${target.source || '未命名线路'} · ${target.model}`, row);
      element('p', `${target.enabled ? result?.state || '待检测' : '已停用'}${result?.stale ? '（已过期）' : ''}`, row);
      if (result?.checkedAt) element('p', `${new Date(result.checkedAt).toLocaleTimeString()} · ${result.latency}ms · 下次${result.nextAt === Number.MAX_SAFE_INTEGER ? '鉴权暂停' : new Date(result.nextAt).toLocaleTimeString()}`, row).className = 'note';
      const check = button(row, '检测此模型', async () => { await window.monitor.checkHealth(target.id); await refresh(); });
      check.disabled = !snapshot.config.enabled || !target.enabled;
    }
  }
  async function refresh() { if (results) showResults(await window.monitor.getHealth()); }
  window.monitor.getHealth().then(render).catch(() => { panel.textContent = '检测配置读取失败；未启用检测'; });
  setInterval(() => { if (!document.querySelector('#settings-panel').hidden) refresh().catch(() => {}); }, 2000);
})();
