import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSource } from '../privacy-audit.mjs';
import { detectChannel } from '../channel-detector.mjs';

test('channel detection is local, conservative and redacts credentials', () => {
  assert.equal(detectChannel({ source: 'codex', endpoint: 'https://api.openai.com/v1' }), 'official-api');
  assert.equal(detectChannel({ source: 'codex', endpoint: 'https://token:secret@relay.example/v1?key=hidden' }), 'relay');
  assert.equal(detectChannel({ source: 'codex' }), 'not-configured');
});

test('Qwen local telemetry settings produce privacy evidence without network access', async context => {
  const home = await mkdtemp(join(tmpdir(), 'ai-yaoce-audit-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.qwen'), { recursive: true });
  await writeFile(join(home, '.qwen', 'settings.json'), JSON.stringify({ telemetry: { logPrompts: true, target: 'gcp' }, usageStatisticsEnabled: true }));
  const result = auditSource({ home, source: 'qwen-codex' });
  assert.equal(result.channel, 'unknown');
  assert.ok(result.items.some(item => item.label.includes('记录提示词')));
  assert.ok(result.items.some(item => item.label.includes('使用统计')));
  assert.ok(result.items.some(item => item.value === 'gcp'));
  assert.ok(!JSON.stringify(result).includes('https://'));
});

test('local entitlements are shown only when explicit fields exist', async context => {
  const home = await mkdtemp(join(tmpdir(), 'ai-yaoce-entitlements-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.dsh'), { recursive: true });
  await writeFile(join(home, '.dsh', 'account.json'), JSON.stringify({ balance: 12.5, plan: 'pro', planExpiry: '2026-12-31T00:00:00Z', quotaWindows: [{ name: '5h', usedPercent: 25, resetAt: '2026-10-04T22:00:00Z' }] }));
  const result = auditSource({ home, source: 'dsh-deepseek' });
  assert.equal(result.entitlements.balance, 12.5);
  assert.equal(result.entitlements.plan, 'pro');
  assert.equal(result.entitlements.quotaWindows[0].name, '5h');
  assert.equal(result.channel, 'official-subscription');
});
