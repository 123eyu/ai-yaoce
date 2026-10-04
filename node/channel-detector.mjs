const OFFICIAL_HOSTS = {
  codex: ['openai.com', 'chatgpt.com'],
  claude: ['anthropic.com', 'claude.ai'],
  zcodex: ['z.ai'],
  'dsh-deepseek': ['deepseek.com'],
  'qwen-codex': ['aliyun.com', 'dashscope.aliyuncs.com'],
  'kimi-codex': ['moonshot.cn', 'moonshot.ai'],
};

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

export function detectChannel({ source, endpoint = '', subscription = false, evidence = [] } = {}) {
  if (subscription) return 'official-subscription';
  const host = hostOf(endpoint);
  if (!host) return evidence.length ? 'unknown' : 'not-configured';
  const official = (OFFICIAL_HOSTS[source] ?? []).some(domain => host === domain || host.endsWith(`.${domain}`));
  return official ? 'official-api' : 'relay';
}
