import type { PostgresDatabase } from '../../src/lib/db/adapters/postgres/database.mts'
import type { UsersRepo, UserRecord } from '../../src/lib/db/adapters/postgres/repos/users-repo.mts'

declare const db: PostgresDatabase
declare const users: UsersRepo

const query = db.query<{ role: string }>('SELECT role FROM users')
// @ts-expect-error SQL results cannot be read before awaiting the query.
query.rows
const role: string | undefined = (await query).rows[0]?.role
// @ts-expect-error Typed query columns must not silently become any.
const invalidRole: number = (await query).rows[0]?.role
const list: UserRecord[] = await users.list()
// @ts-expect-error Lists remain asynchronous even when the caller only needs length.
users.list().length
// @ts-expect-error User records have typed balances.
const invalidBalance: string | undefined = (await users.getById('u1'))?.balance
const transaction = db.transaction(() => users.getById('u1'))
const locked = db.withEntityLock('user', 'u1', () => users.getById('u1'))
const transactionUser: UserRecord | null = await transaction
const lockedUser: UserRecord | null = await locked
// @ts-expect-error Transactions preserve asynchronous result types.
transaction.role
// @ts-expect-error Entity locks preserve asynchronous result types.
locked.role
// @ts-expect-error Lock callback results must not silently become any.
const invalidLock: number = await locked
const syncResult: number = await db.transaction(() => 42)
