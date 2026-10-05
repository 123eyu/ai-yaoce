# Windows 轻量版进度

## 2026-10-05
- 用户确认继续原生托盘方向；已读台账与设计/验收技能。
- 新代码隔离在windows/，不修改旧Electron与macOS功能。
- 验证待执行；回滚为v1.9.0，保留旧安装包但不覆盖配置。
- 首轮Windows编译、核心单测、安装包体积门禁通过；验收脚本参数home与PowerShell只读HOME冲突，改为testHome后重跑，未发布。
