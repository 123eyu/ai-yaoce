export const SOURCE_DEFINITIONS = Object.freeze([
  { id: 'codex', label: 'Codex', kind: 'client', roots: ['.codex'] },
  { id: 'claude', label: 'Claude Code', kind: 'client', roots: ['.claude'] },
  { id: 'zcodex', label: 'zCodex', kind: 'domestic', roots: ['.zcode', '.zcodex'] },
  { id: 'dsh-deepseek', label: 'DSH DeepSeek', kind: 'domestic', roots: ['.dsh', '.deepseek'] },
  { id: 'qwen-codex', label: 'Qwen Codex', kind: 'domestic', roots: ['.qwen'] },
  { id: 'kimi-codex', label: 'Kimi Codex', kind: 'domestic', roots: ['.kimi-code', '.kimi'] },
]);

export const SOURCES = SOURCE_DEFINITIONS.map(source => source.id);
export const SOURCE_LABELS = Object.fromEntries(SOURCE_DEFINITIONS.map(source => [source.id, source.label]));

export function sourceDefinition(source) {
  return SOURCE_DEFINITIONS.find(value => value.id === source) ?? null;
}
