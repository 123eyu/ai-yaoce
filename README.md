# AI 遥测

`ai-yaoce` 是一个跨平台、本地优先的 AI 使用、订阅状态和隐私审计工具，支持 macOS 原生版与 Windows/Electron 版。

## 监控来源

- Codex
- Claude Code
- zCodex
- DSH DeepSeek
- Qwen Codex
- Kimi Codex

来源可以独立显示。没有本地证据的余额、套餐、5 小时或 7 天额度不会被猜测或填充。

## 隐私边界

- 只读取本机客户端配置、会话、用量日志和本地缓存。
- 不主动调用官方接口，不做代理、抓包或拦截请求。
- 不上传日志、提示词、代码、账号信息或审计结果。
- 不保存明文凭据；账号信息只保存在用户本机。
- 隐私审计只展示脱敏后的端点、配置字段和本地日志证据。
- “未发现本地上传证据”不等于“客户端绝对没有上传”。

## 开发

### macOS

需要 macOS 14+ 与 Command Line Tools：

```bash
bash build.sh build
open "build/AI 遥测.app"
```

安装到当前用户应用目录：

```bash
bash install.sh
```

### Windows / Electron

```bash
npm install
npm test
npm run smoke
npm run dist:win
```

Windows 安装包输出到 `release/`，应用数据使用 `ai-yaoce` 目录。

## 本地路径

AI 遥测自己的设置和缓存使用：

- macOS：`~/Library/Application Support/ai-yaoce/`
- Windows：`%APPDATA%/ai-yaoce/`
- 其他 Unix：`~/.ai-yaoce/`

各客户端的原始目录只读，不会被 AI 遥测改名、删除或上传。

## 文档

- 设计规格：`docs/superpowers/specs/2026-10-04-ai-yaoce-design.md`
- 软件设计说明：`docs/SDD-ai-yaoce.md`
- 开发约束与验收项：`docs/SDD-ai-yaoce.md`

## 许可证

MIT License，详见 `LICENSE`。
