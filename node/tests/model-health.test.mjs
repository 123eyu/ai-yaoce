import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ModelHealth, defaultHealthConfig, validateHealthConfig, healthRequest, healthResponse } from '../model-health.mjs';

const target = (id = 'one') => ({ id, source: 'test', endpoint: 'https://example.test/v1/chat/completions', model: id, protocol: 'chat', enabled: true, reasoning: false, apiKey: 'fixture-secret', inputPrice: 1, outputPrice: 2 });
const config = (enabled = true) => ({ ...defaultHealthConfig(), enabled, targets: [target()] });
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: '1' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));

test('health defaults off and exposes no keys', () => {
  const engine = new ModelHealth({ config: config(false), automatic: false, fetcher: () => { throw Error('must not call'); } });
  engine.tick(); assert.equal(engine.stats.requests, 0);
  assert.throws(() => engine.check(), /开启/);
  assert(!JSON.stringify(engine.snapshot()).includes('fixture-secret'));
  assert.equal(defaultHealthConfig().interval, 600); engine.close();
});
test('health validates endpoints, identity, limits and key retention', () => {
  for (const endpoint of ['http://example.test/api', 'https://user:pass@example.test', 'https://example.test/?key=secret', 'https://example.test/#secret']) {
    assert.throws(() => validateHealthConfig({ ...config(), targets: [{ ...target(), endpoint }] }));
  }
  assert.throws(() => validateHealthConfig({ ...config(), interval: 0 }));
  assert.throws(() => validateHealthConfig({ ...config(), targets: [target(), { ...target('two'), model: 'one' }] }));
  const previous = validateHealthConfig(config());
  assert.equal(validateHealthConfig({ ...config(), targets: [{ ...target(), apiKey: '' }] }, previous).targets[0].apiKey, 'fixture-secret');
  assert.equal(validateHealthConfig({ ...config(), targets: [{ ...target(), apiKey: '', endpoint: 'https://other.test/' }] }, previous).targets[0].apiKey, '');
  assert.equal(validateHealthConfig({ ...config(), targets: Array.from({ length: 1200 }, (_, index) => target(String(index))) }).targets.length, 1200);
});
test('health builds three minimal protocols without redirect or tools', () => {
  for (const protocol of ['chat', 'responses', 'anthropic']) {
    const request = healthRequest(config(), { ...target(), protocol });
    const body = JSON.parse(request.body);
    assert.equal(request.redirect, 'manual'); assert.equal(body.stream, false); assert.equal(body.tools, undefined);
    assert.equal(body.max_tokens ?? body.max_output_tokens, 8);
    assert.equal(body.input ?? body.messages[0].content, 'Reply 1');
  }
  assert.equal(JSON.parse(healthRequest(config(), { ...target(), reasoning: true }).body).max_completion_tokens, 8);
});
test('health distinguishes errors, empty success and usage', () => {
  assert.equal(healthResponse(401).state, '鉴权失败'); assert.equal(healthResponse(429).state, '限流');
  assert.equal(healthResponse(302).state, '拒绝重定向'); assert.equal(healthResponse(500).state, '服务错误');
  assert.equal(healthResponse(200, {}).state, '未确认');
  assert.equal(healthResponse(200, { output: [{ content: [{ type: 'output_text', text: '1' }] }] }).state, '可用');
  assert.equal(healthResponse(200, { content: [{ type: 'text', text: '1' }], usage: { input_tokens: 2, output_tokens: 1 } }).input, 2);
});
test('budget exhaustion with partial text stays unconfirmed', () => {
  for (const data of [
    { choices: [{ message: { content: '1' }, finish_reason: 'length' }] },
    { output_text: '1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    { content: [{ type: 'text', text: '1' }], stop_reason: 'max_tokens' }
  ]) assert.equal(healthResponse(200, data).state, '未确认');
});
test('saving unrelated settings preserves auth pause and scheduled probes', async () => {
  const engine = new ModelHealth({ config: config(), automatic: false, clock: () => 1000, fetcher: async () => new Response('', { status: 401 }) });
  await engine.run(engine.config.targets[0]);
  await engine.save({ ...engine.snapshot().config, prompt: 'Reply 2' });
  engine.tick(); assert.equal(engine.stats.requests, 1);
  assert.equal(engine.results.get('one').state, '鉴权失败');
  await engine.save({ ...engine.snapshot().config, enabled: false });
  await engine.save({ ...engine.snapshot().config, enabled: true });
  engine.tick(); assert.equal(engine.stats.requests, 2); engine.close();
});
test('health accumulates separate usage and waits after completion', async () => {
  const engine = new ModelHealth({ config: config(), automatic: false, clock: () => 1000, fetcher: async () => reply() });
  await engine.run(engine.config.targets[0]);
  assert.equal(engine.results.get('one').nextAt, 601000); assert.equal(engine.stats.requests, 1);
  assert.equal(engine.stats.estimatedUSD, 0.000005); assert.equal(engine.stats.input, 3); engine.close();
});
test('health respects Retry-After and auth pause', async () => {
  const engine = new ModelHealth({ config: config(), automatic: false, clock: () => 1000, fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': '7200' } }) });
  await engine.run(engine.config.targets[0]); assert.equal(engine.results.get('one').nextAt, 7201000);
  engine.fetcher = async () => new Response('', { status: 401 });
  await engine.run(engine.config.targets[0]); assert.equal(engine.results.get('one').nextAt, Number.MAX_SAFE_INTEGER); engine.close();
});
test('health caps concurrency, aborts on disable and discards old results', async () => {
  let active = 0, maximum = 0;
  const engine = new ModelHealth({ config: { ...config(), targets: [target(), target('two'), target('three')] }, automatic: false,
    fetcher: async (_url, options) => new Promise((_resolve, reject) => {
      active++; maximum = Math.max(maximum, active);
      options.signal.addEventListener('abort', () => { active--; reject(Error('aborted')); });
    }) });
  engine.tick(); engine.tick(); assert.equal(maximum, 2);
  await engine.save({ ...engine.snapshot().config, enabled: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 0); assert([...engine.results.values()].every(result => result.state === '已取消')); engine.tick(); assert.equal(engine.stats.requests, 2); engine.close();
});
test('health persistence failure never replaces target configuration', async () => {
  const engine = new ModelHealth({ config: config(false), automatic: false, persist: async () => { throw Error('storage'); } });
  await assert.rejects(engine.save({ ...config(), prompt: 'new' }));
  assert.equal(engine.config.prompt, 'Reply 1'); assert.equal(engine.config.enabled, false); engine.close();
});
test('manual target check takes priority over other due targets', () => {
  const requested = [];
  const engine = new ModelHealth({ config: { ...config(), targets: [target(), target('two'), target('three')] }, automatic: false,
    fetcher: async (_url, options) => { requested.push(JSON.parse(options.body).model); return reply(); } });
  engine.check('three'); assert.equal(requested[0], 'three'); engine.close();
});
test('malformed successful payload is unconfirmed rather than a parser crash', () => {
  for (const data of [null, [], { content: 3 }, { output: {} }, { choices: [{ message: { content: {} } }] }]) {
    assert.equal(healthResponse(200, data).state, '未确认');
  }
});
test('real loopback transport rejects redirects, limits body and times out', async () => {
  let captured = 0;
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/capture' }); response.end(); }
    else if (request.url === '/capture') { captured++; response.end('{}'); }
    else if (request.url === '/large') response.end('x'.repeat(1048577));
    else if (request.url === '/wait') { request.on('close', () => response.destroy()); }
    else { response.setHeader('content-type', 'application/json'); response.end('{"content":[{"type":"text","text":"1"}]}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = new ModelHealth({ config: { ...config(), timeout: 1 }, automatic: false });
  try {
    for (const [path, state] of [['/redirect', '拒绝重定向'], ['/large', '未确认'], ['/wait', '超时'], ['/ok', '可用']]) {
      const entry = { ...target(), endpoint: `http://127.0.0.1:${server.address().port}${path}` };
      await engine.run(entry); assert.equal(engine.results.get(entry.id).state, state);
    }
    assert.equal(captured, 0);
  } finally { engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
