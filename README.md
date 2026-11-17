# 写作管理插件

独立 Git submodule 和 pnpm 工程，当前已建立 TypeScript 迁移目录。

| 目录 | 职责 |
|---|---|
| `src` | 生产写作前端、公开入口与激活 |
| `backend/src` | 工程、书目、文件与编译领域决策 |
| `host/src` | Node 宿主与有限协议适配 |
| `preview/src` | 公开宿主上的插件预览与完整产品组合 |
| `tests/contracts` | 写作领域与协议验收 |
| `tests/acceptance` | 使用公开产物的完整产品组合验收 |

Core 拥有真实文件、进程、共享 Agent、事务与恢复执行。本插件通过版本化公开契约协作。
依赖、锁文件和严格 TypeScript 配置由本工程维护，可执行入口随能力迁移加入。
