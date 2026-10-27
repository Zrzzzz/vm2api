import fs from 'node:fs'
import crypto from 'node:crypto'
import {PostgresDatabase,postgresConfig} from '../../src/lib/db/adapters/postgres/database.mts'
export async function createTestDatabase() {
 const schema='test_'+crypto.randomBytes(8).toString('hex')
 const admin=new PostgresDatabase(postgresConfig())
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.close()
 const db=new PostgresDatabase(postgresConfig({...process.env,PGSCHEMA:schema}))
 await db.initializeBaseline(fs.readFileSync(new URL('../../src/lib/db/postgres-migrations/001_baseline.sql',import.meta.url),'utf8'))
 await db.applyMigration('002',fs.readFileSync(new URL('../../src/lib/db/postgres-migrations/002_upstream_207.sql',import.meta.url),'utf8'))
 return db
}
