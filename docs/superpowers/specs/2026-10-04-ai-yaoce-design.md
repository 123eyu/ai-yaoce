# AI 遥测（ai-yaoce）设计规格

日期：2026-10-04
状态：已获用户确认，待实施

## 目标

将现有二开项目发展为独立公开仓库 `ai-yaoce`，安装后显示名称为“AI 遥测”，同时支持 macOS 原生版与 Windows/Electron 版。保留现有 logo，不再把 Mirasim 作为监控来源，保留 Codex、Claude，并增加 zcodex、DSH DeepSeek、Qwen Codex、Kimi Codex。

## 隐私边界

- 只读取用户设备上的配置、会话、订阅缓存、用量日志和本地进程信息。
- AI 遥测不主动调用官方接口，不上传日志，不向第三方发送测试内容，不保存明文凭据。
- 账号与审计结果仅保存在用户本机；应用数据目录、配置文件名、启动项和安装路径统一使用 `ai-yaoce`。
- 读取不到订阅或余额信息时隐藏该字段，不用历史值、推算值或默认值冒充官方数据。
- “隐私审计”只做被动证据整理：配置地址、客户端声明、日志中可见的元数据与本地遥测线索。没有发现证据时显示“未发现本地证据”，不宣称绝对安全。
- 不删除或改写各客户端自己的目录；移除监控只停止读取该来源。

## 统一数据模型

每个监控来源输出统一快照：

```text
source: codex | claude | zcodex | dsh-deepseek | qwen-codex | kimi-codex
channel: official-subscription | official-api | relay | unknown
availability: active | stale | unavailable | not-configured
account: local-only summary or null
quotaWindows: optional 5h/7d/custom windows
balance: optional amount/currency/reset time
planExpiry: optional date
usage: local token/request summaries
privacyAudit: evidence items with confidence and source path
warnings: non-fatal limitations
```

官方订阅、官方 API、中转和未知渠道必须由证据驱动。来源探测器不能因为名称中出现“codex”或“official”就直接判定渠道。

## 来源适配器

### Codex / Claude

复用现有本地日志解析、账号缓存和可验证的额度读取逻辑，去掉 Mirasim relay 作为展示来源。保留已有 5 小时、7 天及套餐到期字段的显示能力，但只在本地数据明确提供时显示。

### zcodex / DSH DeepSeek / Qwen Codex / Kimi Codex

采用独立适配器，不把国产客户端强行映射为 Codex 或 Claude。第一阶段只接入能够在本机稳定识别的路径、配置键、日志字段和余额/套餐字段；未知格式显示“已发现客户端，暂无法读取详情”，而不是伪造额度。

DSH DeepSeek 优先支持余额字段；其他来源优先支持套餐到期时间、订阅状态与本地用量。若客户端提供 5 小时、7 天或自定义窗口，则按原始窗口名显示。

## 账号切换

- 只对已发现、已验证可以安全切换的官方账号显示入口。
- 本地账号库使用 `ai-yaoce` 的应用数据目录，保存加密/系统保护后的凭据块或客户端原生登录引用，不写入明文 token。
- 切换前生成本地备份，切换后重新读取本地状态并验证目标账号；失败自动恢复原状态。
- 未发现账号、客户端不支持安全切换或凭据来源不明时，隐藏切换入口。

## 隐私审计界面

每个来源提供“隐私审计”折叠区：

- 服务地址：脱敏展示域名和端口，不展示 token、完整路径中的个人目录或请求正文。
- 数据证据：本地日志/配置中实际出现的字段，例如模型名、请求时间、token 计数、文件路径标识。
- 可能上传：仅列出客户端明确声明或本地记录可佐证的项目；无法证明时标记“无法判断”。
- 证据时间与文件来源：显示相对路径、时间和可信度，支持清除本地审计缓存。

## 双端实现

- Swift/macOS 与 Node/Electron 使用相同字段命名、来源枚举、渠道状态和隐私审计结果结构。
- Windows 先实现统一 Node backend，再由 Electron UI 展示；macOS 在现有 Store/Model/PanelView 上接入相同抽象。
- UI 仍保留现有 logo 和现有紧凑监控布局，但顶部来源切换、卡片标题、菜单、安装文案和数据路径全部改为 AI 遥测语义。
- 现有 Mirasim 专属 UI、relay 额度入口和 Mirasim 账号提示移除；客户端数据解析能力保留并迁移到对应来源适配器。

## 迁移与回滚

- 新仓库与新应用使用 `ai-yaoce` 标识；不重写旧仓库历史。
- 旧版应用目录和旧用户数据不自动删除；首次运行可只读发现旧数据并提示迁移，迁移必须由用户主动确认。
- 每个阶段保持可构建：先完成命名与来源抽象，再逐个接入新来源，最后做账号切换和隐私审计。
- 如新适配器失败，可禁用单个来源而不影响其他来源与主界面。

## 验收标准

1. macOS 与 Windows 构建产物、安装路径、应用名称、数据目录和启动项均显示 `AI 遥测`/`ai-yaoce`，保留现有 logo。
2. UI 不再显示 Mirasim 来源或 Mirasim 账号入口；Codex 与 Claude 仍能读取现有本地记录。
3. 六个来源均可启用/停用；来源不可用时有明确空状态，不影响其他来源。
4. 官订信息只在本地读取到时显示；5 小时、7 天、余额、套餐到期时间不被推算或伪造。
5. 账号切换入口按能力动态显示，切换失败可恢复，凭据不以明文落盘。
6. 隐私审计只读本地证据，不发起网络请求，不上传本地数据，不展示完整敏感值。
7. Node 单元测试、macOS 离线测试、Windows/Electron smoke 测试覆盖来源枚举、快照、路径迁移和审计脱敏。

## 未承诺事项

各国产客户端的真实本地文件格式、余额接口缓存格式、官方订阅字段和账号切换机制可能不同。若没有本地证据，第一版只提供来源识别和“无法读取”的明确状态，不会绕过登录、不抓包、不猜测服务端数据。
