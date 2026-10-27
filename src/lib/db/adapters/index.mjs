import * as jev_usage_repo from './postgres/repos/jev-usage-repo.mjs'
import * as backup from './postgres/backup.mjs'
import { snapshotDatabaseMetrics } from './postgres/metrics.mjs'
import { PostgresDatabase, postgresConfig } from './postgres/database.mts'
import * as account_runtime_repo from './postgres/repos/account-runtime-repo.mjs'
import * as accounts_repo from './postgres/repos/accounts-repo.mjs'
import * as api_endpoints_repo from './postgres/repos/api-endpoints-repo.mjs'
import * as api_keys_repo from './postgres/repos/api-keys-repo.mjs'
import * as backup_repo from './postgres/repos/backup-repo.mjs'
import * as cluster_nodes_repo from './postgres/repos/cluster-nodes-repo.mjs'
import * as proxies_repo from './postgres/repos/proxies-repo.mjs'
import * as redeem_codes_repo from './postgres/repos/redeem-codes-repo.mjs'
import * as refusal_device_blocks_repo from './postgres/repos/refusal-device-blocks-repo.mjs'
import * as refusal_guards_repo from './postgres/repos/refusal-guards-repo.mjs'
import * as request_attempts_repo from './postgres/repos/request-attempts-repo.mjs'
import * as statistics_repo from './postgres/repos/statistics-repo.mjs'
import * as sticky_repo from './postgres/repos/sticky-repo.mjs'
import * as usage_log_preds from './postgres/repos/usage-log-preds.mjs'
import * as usage_logs_repo from './postgres/repos/usage-logs-repo.mjs'
import * as usage_logs_view from './postgres/repos/usage-logs-view.mjs'
import * as users_repo from './postgres/repos/users-repo.mts'
import * as vm_pools_repo from './postgres/repos/vm-pools-repo.mjs'
import * as vms_repo from './postgres/repos/vms-repo.mjs'

const engine = process.env.KIN_DB_ENGINE || 'postgres'
if (engine !== 'postgres') throw new Error('Database adapter is not installed: ' + engine)

export const adapter = { engine, Database:PostgresDatabase, config:postgresConfig, backup, metrics:snapshotDatabaseMetrics }
export const repositories = { jev_usage_repo, account_runtime_repo, accounts_repo, api_endpoints_repo, api_keys_repo, backup_repo, cluster_nodes_repo, proxies_repo, redeem_codes_repo, refusal_device_blocks_repo, refusal_guards_repo, request_attempts_repo, statistics_repo, sticky_repo, usage_log_preds, usage_logs_repo, usage_logs_view, users_repo, vm_pools_repo, vms_repo }
