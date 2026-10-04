import { existsSync, readFileSync } from 'node:fs';
import { sourceDefinition } from './source-registry.mjs';

const CONFIG_FILES = {
  codex: ['.codex/config.json', '.codex/subscription.json'],
  claude: ['.claude/subscription.json', '.claude/settings.json'],
  zcodex: ['.zcode/account.json', '.zcode/config.json', '.zcodex/account.json'],
  'dsh-deepseek': ['.dsh/account.json', '.dsh/balance.json', '.dsh/settings.yaml'],
  'qwen-codex': ['.qwen/account.json', '.qwen/subscription.json', '.qwen/settings.json'],
  'kimi-codex': ['.kimi-code/account.json', '.kimi-code/subscription.json', '.kimi-code/config.toml'],
};

const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const date = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value > 1e11 ? value : value * 1000).toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
};

function jsonFields(value, result) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (!result.balance && ['balance', 'credits', 'remaining_balance', 'remainingbalance'].includes(lower)) result.balance = number(item) ?? text(item);
    if (!result.planExpiry && ['planexpiry', 'plan_expiry', 'expiresat', 'expires_at', 'subscriptionexpiry'].includes(lower)) result.planExpiry = date(item);
    if (['plan', 'planname', 'subscription'].includes(lower)) result.plan = text(item);
    if (Array.isArray(item) && ['quotawindows', 'quotas', 'limits'].includes(lower)) result.quotaWindows = item.filter(window => window && typeof window === 'object').map(window => ({
      name: text(window.name ?? window.window ?? window.id), usedPercent: number(window.usedPercent ?? window.used_percent ?? window.used), budget: number(window.budget ?? window.limit), resetAt: date(window.resetAt ?? window.reset_at),
    })).filter(window => window.name || window.usedPercent !== null || window.budget !== null);
    jsonFields(item, result);
  }
}

function textFields(content, result) {
  const balance = content.match(/(?:balance|credits|remaining_balance|remainingBalance)\s*[:=]\s*["']?(-?\d+(?:\.\d+)?)/i)?.[1];
  if (result.balance === null && balance !== undefined) result.balance = Number(balance);
  const expiry = content.match(/(?:planExpiry|plan_expiry|expiresAt|expires_at|subscriptionExpiry)\s*[:=]\s*["']?([^,"'\s}]+)/i)?.[1];
  if (!result.planExpiry && expiry) result.planExpiry = date(expiry);
  const plan = content.match(/(?:plan|planName)\s*[:=]\s*["']([^"']+)/i)?.[1];
  if (!result.plan && plan) result.plan = plan;
  for (const name of ['5h', '7d']) {
    const pattern = new RegExp(`${name}[^\\n]{0,120}?(?:usedPercent|used|percent)\\s*[:=]\\s*["']?(\\d+(?:\\.\\d+)?)`, 'i');
    const used = content.match(pattern)?.[1];
    if (used !== undefined) result.quotaWindows.push({ name, usedPercent: Number(used), budget: null, resetAt: null });
  }
}

export function readLocalEntitlements({ home, source } = {}) {
  const result = { balance: null, plan: null, planExpiry: null, quotaWindows: [] };
  const roots = sourceDefinition(source)?.roots ?? [];
  const paths = [...(CONFIG_FILES[source] ?? []), ...roots.map(root => `${root}/account.json`)].map(path => `${home}/${path}`);
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let content;
    try { content = readFileSync(path, 'utf8').slice(0, 512 * 1024); } catch { continue; }
    if (path.endsWith('.json')) {
      try { jsonFields(JSON.parse(content), result); } catch { textFields(content, result); }
    } else textFields(content, result);
  }
  return result;
}
