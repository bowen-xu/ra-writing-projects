# ra-writing-projects

写作管理插件，初始版本为 0.1.0。源码、公开入口、资源、锁文件和测试由本工程维护。

## 独立构建

以下命令在本工程根目录执行。SDK 成品目录由其 `artifacts/sdk/latest.json`
定位，目录内包含 `sdk-artifacts.json` 和安装器。

```sh
pnpm sdk:install /absolute/path/to/sdk-package
pnpm install --frozen-lockfile
cargo fetch --locked --manifest-path native/Cargo.toml
pnpm build
pnpm typecheck
```

SDK 安装在本工程 `.dependencies/sdk/`。`pnpm build` 生成包含 manifest、前端
资源和完整 v2 Native 能力的写作插件包，执行原有源码闭包、兼容、共享实例、资源
和许可证校验。Native 构建使用锁定依赖的离线编译，首次 `cargo fetch` 用于准备
其依赖缓存。已准备好全部依赖缓存时，可运行 `pnpm build --offline` 要求前端
安装阶段也离线执行。

只生成与完整写作插件相同的 Native profile 时执行以下命令。

```sh
pnpm build:native --project-files
```

## 测试

```sh
RA_WORKBENCH_SDK_DIRECTORY=/absolute/path/to/workbench/apps/web/dist pnpm test
pnpm test:native
pnpm test:build
```

UI 测试消费 Workbench 已构建的 `/sdk/v1/`，沿用生产包相同的 external 路径映射。
纯领域测试使用本工程夹具，单插件协作测试位于 `preview/tests/`。Core 实现测试
留在 Workbench，完整产品组合验收由父仓库协调。

Native 依赖 SDK 的有限协议与 `agent-api`。真实包集成通过指定的预构建 Native
包及公开协议执行。

## 独立预览

`preview/` 持有完整 App、Agent Canvas、写作 Diff 及交付／恢复演示。预览及协作
测试需要先安装选定版本的公开产物，再安装 `preview/` 的依赖。

| 目录 | 公开依赖 |
|---|---|
| `preview/.dependencies/workbench-preview/` | Workbench 预览宿主 |
| `preview/.dependencies/literature-library-preview/` | 文献公开预览包 |
| `preview/.dependencies/note-manager-preview/` | 笔记公开预览包 |

SDK 依赖继续来自本工程的 `.dependencies/sdk/`。父仓库联调时，在父仓库根目录
执行 `pnpm prepare:previews` 自动准备这些公开产物与依赖。随后回到本工程选择
以下命令。

```sh
pnpm dev:preview
pnpm build:preview
pnpm typecheck:preview
pnpm test:preview
```

公开开发模块由 `preview/public-modules.json` 列出。

## 构建缓存与产物

| 路径 | 内容 |
|---|---|
| `artifacts/plugin/latest.json` | 当前完整写作插件包与回执 |
| `artifacts/native/latest.json` | 当前独立 Native 领域包 |
| `artifacts/preview/latest.json` | 当前公开预览包 |
| `.cache/cargo/native/` | Native 包构建的持久 Cargo 缓存 |
| `native/target/` | 直接执行 Native 检查与测试产生的 Cargo 缓存 |
| `.cache/build/` | 构建输入到已有包的索引 |
| `.cache/logs/` | 按次保存的构建日志 |
| `.cache/work/` | 隔离构建工作目录 |
| `node_modules/.vite/`、`preview/node_modules/.vite/` | Vite／Vitest 缓存 |

标准构建入口校验并复用 `artifacts/<kind>/<内容哈希>/package/` 中的完整产物。
回执随产物保存。清理编译缓存后，同输入构建仍可复用已保存的当前包。

工程位于 Research Assistant 父仓库时，可在父仓库根目录运行统一清理入口。

```sh
pnpm clean:cache writing --dry-run
pnpm clean:cache writing
pnpm clean:cache writing --kind logs
```

默认清理编译缓存并保留构建索引。`--kind logs` 选择构建日志，`--kind all`
还清理构建索引及残留隔离工作目录。索引清除后，构建工具回退核对当前
`latest.json` 对应的包，其他历史输入组合可能重新构建。清理范围与命令说明见
父仓库 README 的缓存章节。
