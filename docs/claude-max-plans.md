# Claude Max 5x / 20x

套餐倍率由槽位 worker 的官方 `GET /api/oauth/profile` 返回值确定：

| organization.rate_limit_tier | 显示 |
| --- | --- |
| default_claude_max_5x | Max 5x |
| default_claude_max_20x | Max 20x |
| 其他 Max 档位或缺失倍率 | Max（倍率未知） |

导入后的官方初始化和 VM 页“主动查询”都会读取 profile，并保存到账号 unified JSON 和 VM claude JSON。已有账号点击“主动查询”即可更新；该操作同时刷新额度和套餐。profile 查询失败会明确报错，不把历史套餐当作本次查询成功。

`account_tier` 表示套餐族（pro / max），`account_max_multiplier` 表示官方明确给出的倍率（5 / 20 / null）。倍率不是额度百分比，也不推导并发上限或绝对 token 配额；调度仍使用现有套餐族策略。数据库 JSON 字段无需迁移。

官方 profile 信息优先于 usage/Fable 推断。升级或降级通过重新查询 profile 更新；降级为 Pro 或 Max 倍率变成未知时清除旧倍率。请求响应头只采集额度，不额外请求 profile。
