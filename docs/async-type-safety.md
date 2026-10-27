# PostgreSQL 异步调用与严格 TypeScript

数据库继续使用 Knex。以下三个模块已从 `.mjs` 替换为 `.mts`，没有保留旧实现或运行时降级路径：

- `src/lib/db/adapters/postgres/database.mts`：连接配置、事务上下文、泛型 SQL 查询、事务及实体锁返回值。
- `src/lib/db/adapters/postgres/repos/users-repo.mts`：数据库行、用户读取/写入契约，以及所有仓库方法的异步返回类型。
- `src/lib/admin/resource-owner.mts`：用户角色读取、租户范围、VM 和代理所有权判断。

数据库角色查询失败现在直接向调用方传播异常，不再把异常转成空角色继续做权限判断。

## 运行环境

使用 Node.js 22.18+（22.x）或 24+ 的原生 TypeScript 类型擦除加载 `.mts`。`package.json` 的 engines 和 `.npmrc` 的 `engine-strict=true` 会拒绝不支持的安装环境。`erasableSyntaxOnly` 禁止依赖额外转译的 TypeScript 语法；不使用 ts-node、tsx 或第二套 JavaScript 构建产物。

原生类型擦除不负责类型检查，因此 CI、发布和镜像构建必须执行以下检查：

```sh
npm ci
npm run check
npm run test:async-guards
```

## 检查范围

- `check:strict`：所有 `src/**/*.mts` 和数据库契约测试使用 `strict: true`、`verbatimModuleSyntax`、`erasableSyntaxOnly`，必须零错误，不使用历史基线。新建 `.mts` 会自动进入此检查。
- `check:types`：继续检查既有 JSDoc 契约和请求范围类型测试，并解析 `.mts` 中的实际类型。
- `check:async-lint`：PostgreSQL adapter、所有权/Key 范围、消息/token 计数入口、调度器和 failover runner。`no-floating-promises` 开启 `ignoreVoid: false` 和 `checkThenables: true`，同时拦截原生 Promise 与 Knex 的可等待查询对象；`no-misused-promises` 拦截 Promise 条件及不合适的同步回调。迁移模块禁止显式 `any`。
- `check:type-regressions`：其余后端仍以全量 `checkJs` 加诊断基线防止新增错误。当前历史诊断为 1,947 项，不代表全后端已迁移或类型零错误。未迁移的仓库仍需要逐步补充具体行类型；驱动默认行类型不能替代这些契约。
- `test:async-guards`：故意删除用户查询、角色查询、Messages 和 count-tokens 入口的 `await`；验证事务回调隐式 any、未等待的 Knex 查询/事务/实体锁、Promise 条件都被拦截。

事务和锁支持同步或异步回调，但对外统一返回 `Promise<T>`，调用者需要读取结果时仍必须等待。不能把 `await` 删除当作类型改造目标。

## 回归验证

Linux 运行已有的 `panel-import-async` 测试需要安装 `trash-cli`；CI 已加入安装步骤。网关测试会写入源码中的公开配置文件，应在隔离的可写副本中执行。

本次本地验证使用独立 PostgreSQL 17.6 容器，不连接生产 RDS。覆盖并发事务回滚、迁移/增量同步、日志留存、模拟上游网关请求及用户 CRUD/余额/权限范围。模拟上游测试不是生产模型推理验证。

验证结果：Node 24.16.0 本地检查通过；Node 22.23.4 容器中 `npm run check` 与 5 项异步防护测试通过。15 项 PostgreSQL 集成测试、17 项权限/Key 范围/导入测试全部通过（容器初次因只读配置目录和缺少 trash-cli 失败的 5 项，在可写隔离副本并安装 trash-cli 后全部重跑通过）。专用 PostgreSQL 测试容器已停止，保留可恢复的测试数据。已于 2026-10-22 部署生产：`vm2api:rds-pg17-v1.3.207-strict-types-20261022`。真实受影响管理 Key 的 Sonnet 非流式及 Opus 流式 `hello` 请求均通过，输入输出已核对 RDS 落库。

```sh
# 环境变量须指向隔离的测试 PostgreSQL。
node --test test/postgres/*.test.mjs
node --test test/unit/resource-owner.test.mjs test/unit/key-scope.test.mjs test/unit/panel-import-async.test.mjs
```

类型基线只允许在确认旧错误消除后手动收缩；不能增加基线来掩盖新类型错误。CI、发布和镜像构建不会自动更新基线。

```sh
node scripts/check-type-regressions.mjs --update-baseline
```

`Dockerfile.rds` 已复制两个 TypeScript 检查配置，构建阶段必须通过 `npm run check` 和异步防护测试。仅修改工作区不会更新生产容器。

## 构建下载源

RDS 检查阶段的 Node 镜像来自 `docker.1ms.run/library/node`，运行阶段基础镜像来自 `ghcr.1ms.run/dofastted/vm2api`。npm 配置和锁文件保持 `https://registry.npmmirror.com/`；失败直接报错，不切换备用源。
