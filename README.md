# ra-writing-projects

写作管理插件，初始版本为 0.1.0。源码、公开入口、资源、锁文件和测试由本工程维护。

## 独立构建

```sh
pnpm sdk:install -- /path/to/sdk-artifacts
pnpm install --frozen-lockfile
pnpm build --offline
pnpm typecheck
```

SDK 来自版本化公开产物，安装在本工程 .dependencies/sdk/。构建复用原有源码闭包、兼容、共享实例、资源和许可证校验。产物及回执位于 .tmp/runtime-plugins/。

## 测试

```sh
RA_WORKBENCH_SDK_DIRECTORY=/path/to/workbench-web-dist pnpm test
pnpm test:native
pnpm test:build
pnpm build:test-support
```

UI 测试消费 Workbench 已构建的 /sdk/v1/，沿用生产包相同的 external 路径映射。纯领域测试使用本工程夹具。涉及 Core 私有夹具或多个工程的回归由主仓库 integration/ 执行。

Native 依赖 SDK 的有限协议与 agent-api。测试支持源码产物用于 Core 的现有回归，由本工程单独打包并记录版本与完整性。

## 独立预览

preview/ 持有完整 App、Agent Canvas、写作 Diff 及交付／恢复演示，使用公开的 @research-assistant/workbench-preview 开发包。
父仓 pnpm prepare:previews 准备公开依赖后，可在本项目运行 pnpm dev:preview、pnpm build:preview 和 pnpm typecheck:preview。
公开开发模块由 preview/public-modules.json 列出，产物保存在 artifacts/preview/。
