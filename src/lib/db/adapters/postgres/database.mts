import fs from 'node:fs'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import knexModule from 'knex'
import type { Knex } from 'knex'
import type { QueryResult, QueryResultRow } from 'pg'

type TransactionContext = {
  database: PostgresDatabase
  executor: Knex.Transaction
  active: boolean
  entityLocks: Set<string>
}
type DatabaseConfig = Knex.PgConnectionConfig & {
  max: number
  connectionTimeoutMillis: number
  idleTimeoutMillis: number
}
type DatabaseError = Error & { code?: string; detail?: string; where?: string }
const transactions = new AsyncLocalStorage<TransactionContext>()

export function postgresConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  for (const key of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
    if (!env[key]) throw new Error(`Missing required database setting: ${key}`)
  }
  const max = Number(env.PGPOOL_MAX || 15)
  if (!Number.isInteger(max) || max < 1 || max > 20) {
    throw new Error('PGPOOL_MAX must be 1..20; reserve capacity for operations')
  }
  const schema = env.PGSCHEMA || 'public'
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid PGSCHEMA')
  const local = ['localhost', '127.0.0.1', '::1'].includes(env.PGHOST ?? '')
  const mode = env.PGSSLMODE || 'verify-full'
  if (mode !== 'verify-full' && !(local && mode === 'disable')) {
    throw new Error('Remote PostgreSQL requires verified TLS')
  }
  const port = Number(env.PGPORT || 5432)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PGPORT')
  return {
    host: env.PGHOST,
    port,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    max,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    query_timeout: 35000,
    application_name: 'vm2api',
    options: `-c search_path=${schema},pg_catalog -c timezone=UTC -c synchronous_commit=on`,
    ssl:
      mode === 'disable'
        ? false
        : {
            rejectUnauthorized: true,
            ...(env.PGSSLROOTCERT ? { ca: fs.readFileSync(env.PGSSLROOTCERT, 'utf8') } : {}),
          },
    types: {
      getTypeParser(oid, format?: string) {
        if (oid === 20 && format !== 'binary') {
          return (value: string) => {
            const number = Number(value)
            if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds JavaScript safe range')
            return number
          }
        }
        if (oid === 1700 && format !== 'binary') {
          return (value: string) => {
            const number = Number(value)
            if (!Number.isFinite(number) || (/^-?\d+$/.test(value) && !Number.isSafeInteger(number))) {
              throw new Error('Database numeric value exceeds JavaScript range')
            }
            return number
          }
        }
        if (format !== undefined && format !== 'text' && format !== 'binary')
          throw new Error('Invalid PostgreSQL value format')
        return pg.types.getTypeParser(oid, format === 'binary' ? 'binary' : 'text')
      },
    },
  }
}

/** Native asynchronous PostgreSQL access. A transaction owns one pooled connection. */
export class PostgresDatabase {
  readonly maxConnections: number
  readonly knex: Knex

  constructor(config: DatabaseConfig) {
    const { max, idleTimeoutMillis, connectionTimeoutMillis, ...connection } = config
    this.maxConnections = max
    this.knex = knexModule.knex({
      client: 'pg',
      compileSqlOnError: false,
      connection,
      acquireConnectionTimeout: connectionTimeoutMillis,
      pool: { min: 0, max, idleTimeoutMillis },
    })
    this.knex.on('query-error', (error: DatabaseError) => {
      error.message = 'Database operation failed (' + (error.code || 'unknown') + ')'
      delete error.detail
      delete error.where
    })
  }

  executor(): Knex | Knex.Transaction {
    const context = transactions.getStore()
    if (context?.database === this) {
      if (!context.active) throw new Error('Database transaction scope has ended')
      return context.executor
    }
    return this.knex
  }

  table(name: string) {
    return this.executor()(name)
  }

  async verify() {
    const { rows } = await this.query<{ database: string; version: string }>(
      "SELECT current_database() AS database, current_setting('server_version') AS version",
    )
    return rows[0]
  }

  /**
   * PostgreSQL-only SQL; ordinary repositories use table() query builders.
   */
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly Knex.RawBinding[] = [],
  ): Knex.Raw<QueryResult<Row>> {
    const bindings: Knex.RawBinding[] = []
    const statement = params.length
      ? sql.replace(/\$(\d+)/g, (_, index) => {
          const offset = Number(index) - 1
          if (offset < 0 || offset >= params.length) throw new Error('Invalid PostgreSQL parameter index')
          bindings.push(params[offset])
          return '?'
        })
      : sql
    return this.executor().raw<QueryResult<Row>>(statement, bindings)
  }

  async transaction<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    if (transactions.getStore()?.database === this) throw new Error('Nested database transactions are not supported')
    return await this.knex.transaction(async (executor) => {
      const context = { database: this, executor, active: true, entityLocks: new Set<string>() }
      try {
        return await transactions.run(context, fn)
      } finally {
        context.active = false
      }
    })
  }

  /** Serialize an entity's complete read/modify/write operation across processes. */
  async withEntityLock<T>(
    kind: string,
    id: string | number | null | undefined,
    fn: () => T | PromiseLike<T>,
  ): Promise<T> {
    if (!id) return await fn()
    const lockKey = kind + ':' + id
    const lock = async () => {
      const scope = transactions.getStore()
      if (!scope || scope.database !== this || !scope.active) throw new Error('Database transaction scope has ended')
      if (!scope.entityLocks.has(lockKey)) {
        await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey])
        scope.entityLocks.add(lockKey)
      }
      return await fn()
    }
    const context = transactions.getStore()
    if (context?.database === this) {
      if (!context.active) throw new Error('Database transaction scope has ended')
      return await lock()
    }
    return await this.transaction(lock)
  }

  poolMetrics() {
    const pool = this.knex.client.pool
    return {
      pool_max: this.maxConnections,
      pool_total: pool.numUsed() + pool.numFree(),
      pool_idle: pool.numFree(),
      pool_waiting: pool.numPendingAcquires(),
    }
  }

  async initializeBaseline(sql: string) {
    return await this.applyMigration('001', sql)
  }

  async applyMigration(version: string, sql: string) {
    const checksum = crypto.createHash('sha256').update(sql).digest('hex')
    await this.transaction(async () => {
      await this.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema(), 0))",
      )
      await this.query(
        'CREATE TABLE IF NOT EXISTS postgres_schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
      )
      const { rows } = await this.query<{ checksum: string }>(
        'SELECT checksum FROM postgres_schema_migrations WHERE version=$1',
        [version],
      )
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error('PostgreSQL migration checksum mismatch: ' + version)
        return
      }
      await this.query(sql)
      await this.query('INSERT INTO postgres_schema_migrations (version, checksum) VALUES ($1,$2)', [version, checksum])
    })
  }

  async close() {
    await this.knex.destroy()
  }
}
