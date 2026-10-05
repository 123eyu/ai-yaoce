# AI 遥测

`ai-yaoce` 是一个本地优先的 AI 用量和配置审计工具。Windows 下一版采用原生 Windows Forms 托盘程序；macOS 保留原有 Swift 实现。

## Windows 轻量版 2.0.0

- 不再打包 Electron、Chromium 或 Node，使用系统 .NET Framework 4.8 或以上。
- 安装器检查系统运行时；缺少时提示安装，不偷偷下载组件。应用本身不包含主动网络客户端。
- 支持六来源启停、后台暂停、30/60/120/300 秒刷新、置顶、托盘显示/退出、手动参考价格。
- Codex/Claude 增量读取本地日志，限流扫描且不保存原始正文；国产来源目前以配置审计为主，计量协议未验证时明确提示。
- 官订信息只有明确本地缓存证据时才显示；官方账号切换尚未交付，不显示虚假入口。
- 新版不包含旧版的主动模型健康探测功能。
- 发布包、性能与安装验收报告见仓库 Releases；CI 测试不等于物理设备与真实官订账号完整验收。

Windows x64 默认安装到 `%LOCALAPPDATA%\Programs\ai-yaoce`，设置在 `%APPDATA%\ai-yaoce`。旧 Electron 版不会被偷偷删除；建议先退出并卸载旧版，再安装轻量版，以免旧运行时继续占用磁盘。

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
- Windows 轻量版不主动调用官方接口，不做代理、抓包或拦截请求。旧 Electron/macOS 版的可选健康检测启用后会发请求，严格无主动请求时勿启用。
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

### Windows 轻量版

需要 Windows x64、Visual Studio Build Tools/MSBuild（含 .NET Framework 4.8 targeting pack）、PowerShell 7 和 NSIS 3.13：

```powershell
./windows/build.ps1
```

安装包输出到 `release/windows-lite/`。`.github/workflows/windows-lite.yml` 在隔离 Windows CI 中执行单测、安装/重启/卸载、UI截图与资源采样。`windows/verify.ps1` 是隔离验收脚本，不要在存在正式安装的用户机器上运行。

### 旧版 Electron 开发（1.9.0，非轻量版）

```bash
npm install
npm test
npm run smoke
npm run dist:win
```

此处命令只构建旧 Electron 版，不能用来生成 2.0.0 轻量安装包。

## 本地路径

AI 遥测自己的设置和缓存使用：

- macOS：`~/Library/Application Support/ai-yaoce/`
- Windows：`%APPDATA%/ai-yaoce/`
- 其他 Unix：`~/.ai-yaoce/`

各客户端的原始目录只读，不会被 AI 遥测改名、删除或上传。

## 文档

- 设计规格：`docs/superpowers/specs/2026-10-04-ai-yaoce-design.md`
- 软件设计说明：`docs/SDD-ai-yaoce.md`
- Windows 轻量版设计与验收：`docs/SDD-windows-lite.md`

## 许可证

MIT License，详见 `LICENSE`。
