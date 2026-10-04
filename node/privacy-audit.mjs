import { relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { sourceDefinition } from './source-registry.mjs';
import { detectChannel } from './channel-detector.mjs';
import { readLocalEntitlements } from './local-entitlements.mjs';

const ENDPOINT_ENV = {
  codex: ['OPENAI_BASE_URL', 'CODEX_BASE_URL'],
  claude: ['ANTHROPIC_BASE_URL', 'CLAUDE_BASE_URL'],
  zcodex: ['ZCODEX_BASE_URL'],
  'dsh-deepseek': ['DSH_BASE_URL', 'DEEPSEEK_BASE_URL'],
  'qwen-codex': ['QWEN_BASE_URL', 'DASHSCOPE_BASE_URL'],
  'kimi-codex': ['KIMI_BASE_URL', 'MOONSHOT_BASE_URL'],
};

const CONFIG_FILES = {
  codex: ['.codex/config.toml', '.codex/models.json'],
  claude: ['.claude/settings.json'],
  zcodex: ['.zcode/config.json', '.zcodex/config.json'],
  'dsh-deepseek': ['.dsh/settings.yaml', '.dsh/cordis.patch.yml'],
  'qwen-codex': ['.qwen/settings.json', '.qwen/settings.jsonc'],
  'kimi-codex': ['.kimi-code/config.toml', '.kimi/config.toml'],
};

function redactEndpoint(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function localConfigSignals(home, source) {
  const signals = [];
  for (const name of CONFIG_FILES[source] ?? []) {
    const path = `${home}/${name}`;
    if (!existsSync(path)) continue;
    let text = '';
    try { text = readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, 512 * 1024); } catch { continue; }
    const endpoint = text.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
    if (endpoint) signals.push({ kind: 'endpoint', label: '本地配置服务地址', value: redactEndpoint(endpoint), confidence: 'medium', path: name });
    if (source === 'qwen-codex' && /(?:telemetry\s*[.:]\s*)?logPrompts(?:"|')?\s*[:=]\s*true/i.test(text))
      signals.push({ kind: 'field-observation', label: 'Qwen 配置允许记录提示词', value: 'true', confidence: 'high', path: name });
    if (source === 'qwen-codex' && /(?:"|')?usageStatisticsEnabled(?:"|')?\s*[:=]\s*true/i.test(text))
      signals.push({ kind: 'field-observation', label: 'Qwen 配置启用使用统计', value: 'true', confidence: 'high', path: name });
    if (source === 'qwen-codex' && /(?:telemetry\s*[.:]\s*)?target(?:"|')?\s*[:=]\s*["']?gcp/i.test(text))
      signals.push({ kind: 'client-declaration', label: 'Qwen telemetry 目标', value: 'gcp', confidence: 'high', path: name });
  }
  return signals;
}

export function auditSource({ home, source, fileCount = 0, environment = {} } = {}) {
  const definition = sourceDefinition(source);
  const items = localConfigSignals(home, source);
  const endpointKey = (ENDPOINT_ENV[source] ?? []).find(key => typeof environment[key] === 'string' && environment[key]);
  const endpoint = endpointKey ? redactEndpoint(environment[endpointKey]) : items.find(item => item.kind === 'endpoint')?.value ?? null;
  if (endpoint && !items.some(item => item.kind === 'endpoint' && item.value === endpoint)) items.push({ kind: 'endpoint', label: '本地环境变量服务地址', value: endpoint, confidence: 'medium', path: endpointKey });
  const roots = (definition?.roots ?? []).map(root => `${home}/${root}`);
  const existingRoots = roots.filter(path => existsSync(path));
  if (existingRoots.length) items.push({ kind: 'field-observation', label: '发现本地客户端目录', value: `${existingRoots.length} 个`, confidence: 'low', path: existingRoots.map(path => relative(home, path)).join(', ') });
  if (fileCount > 0) items.push({ kind: 'local-log', label: '发现本地用量日志', value: `${fileCount} 个文件`, confidence: 'medium', path: '适配器扫描结果' });
  if (!items.length) items.push({ kind: 'field-observation', label: '未发现本地上传证据', value: '无法据此证明客户端未上传', confidence: 'low', path: '本地配置与日志摘要' });
  const subscription = items.some(item => item.kind === 'client-declaration' && item.value === 'subscription');
  const entitlements = readLocalEntitlements({ home, source });
  const hasSubscription = Boolean(entitlements.plan || entitlements.planExpiry || entitlements.quotaWindows.length);
  return { channel: detectChannel({ source, endpoint, subscription: subscription || hasSubscription, evidence: items }), items, entitlements, confidence: items.some(item => item.confidence === 'high') ? 'high' : items.some(item => item.confidence === 'medium') ? 'medium' : 'low' };
}
