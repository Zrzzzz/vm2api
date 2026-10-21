# vm2api 数据库适配与 RDS 迁移

业务代码调用 Repository。`src/lib/db/adapters/index.mjs` 明确选择已安装的数据库适配器；当前仅支持 `KIN_DB_ENGINE=postgres`，其他值报错。没有 SQLite 自动回退或双写。

PostgreSQL 适配器使用 Knex 管理连接池、事务和通用查询。配置、分组仓库使用查询构建器；其余仓库的 PostgreSQL 实现、统计 SQL、实体锁、数据库指标及备份操作集中在 `adapters/postgres/`。将来接入其他数据库，需要实现相同仓库契约及对应迁移、锁和备份能力，不能只换驱动就保证全部 SQL 兼容。

## 配置

- `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`
- `PGSCHEMA`：选定的应用 schema
- `PGSSLMODE=verify-full`、`PGSSLROOTCERT`：验证 RDS 证书及域名
- `PGPOOL_MAX=15`：为 20 个连接额度预留运维空间；多进程需要合计计算

凭据只写受保护的运行环境文件，不提交仓库。

## 数据完整性

`migrate-sqlite-to-postgres.mjs` 只读一致性 SQLite 快照，全库导入在一个事务中完成。逐表核对行数和 SHA-256 多重集合指纹。大日志正文在 PostgreSQL 侧计算 UTF-8 内容哈希，避免校验时再次下载完整正文。

`sync-sqlite-to-postgres.mjs` 用新的只读快照同步增量：按主键插入、更新、删除；没有主键的历史表整体替换。所有修改和全表验证位于同一个事务。失败会回滚，不发布部分迁移数据。

最终切换必须先停止旧服务写入，再生成最终快照、执行增量同步并验证；之后切换配置，启动 PostgreSQL 版本。不要让两个生产进程分别向不同数据库写入。

## 日志与事务

请求摘要、正文与尝试记录永久保留，不按天数或容量自动清理。正文沿用应用既有的脱敏和长度限制。摘要与正文在同一事务写入；写入失败记录明确的错误事件，正常关停等待日志写入结束。

账户读改写使用 PostgreSQL 事务级实体锁。API Key 计费窗口和用户并发预留也进行串行化，避免从同步 SQLite 迁移为异步操作后丢失更新。

## 验证

独立 PostgreSQL 测试环境需先配置上述环境变量。执行：

```sh
node --test test/postgres/*.test.mjs
TMPDIR=/tmp node --test test/unit/kernel-router.test.mjs test/unit/rust-kernel-health.test.mjs test/unit/failover-runner.test.mjs
node scripts/check-postgres-regressions.mjs
```

原有单元测试中使用同步 SQLite fixture 的部分尚需按异步数据库契约迁移，不能声称旧测试全集已经通过。类型回归检查与原始 HEAD 比较，原仓库并非零类型诊断。

生产验收必须另行完成：完整备份恢复、最终数据核对、候选实例检查、切换后的真实推理及正文持久化。模拟上游响应不等于真实模型验证。

## v1.3.207 升级

上游标签 v1.3.207 合入 PostgreSQL 定制版本。001 基线及其校验和保持不变；002_upstream_207 通过事务和迁移锁增加节点直连表、节点平台和入站设备字段。已应用迁移的内容变化会明确失败。

备份沿用 PostgreSQL custom-format dump，压缩和哈希操作移到独立 worker，worker 数据库连接池上限为 2。请求完成日志仍通过 trackWrite 登记，关停等待写入结束。节点平台在加载节点时读取到内存，保证同步的槽位运行环境选择不会收到 Promise。

验证命令（PostgreSQL 测试使用独立本地测试库）：

```sh
node --test test/postgres/*.test.mjs
CHECK_BASE_REF=v1.3.207 node scripts/check-postgres-regressions.mjs
pnpm -C web build
cd worker && go test -race ./internal/config ./internal/telemetry ./internal/slotgate
```

生产升级前须保留原镜像、Compose、配置/槽位/二进制快照及数据库备份，在独立恢复库验证迁移前后原字段内容一致。更新后通过保留身份模式同步 kernel/CLI，并刷新遥测 worker；真实非流式、流式响应及 RDS 日志写入是验收条件。
