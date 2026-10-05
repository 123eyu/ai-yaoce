# Windows 轻量版进度

## 2026-10-05
- 用户确认继续原生托盘方向；已读台账与设计/验收技能。
- 新代码隔离在windows/，不修改旧Electron与macOS功能。
- 验证待执行；回滚为v1.9.0，保留旧安装包但不覆盖配置。
- 首轮Windows编译、核心单测、安装包体积门禁通过；验收脚本参数home与PowerShell只读HOME冲突，改为testHome后重跑，未发布。
- UI检查15项通过但退出失败；堆栈确认重复Dispose造成NullReference，增加幂等释放。布局树确认指标父Panel高度100超过容器78，显式百分比行约束并加防裁切断言。
