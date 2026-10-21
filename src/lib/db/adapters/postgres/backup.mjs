import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { postgresConfig } from './database.mjs'

function run(program, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {env, stdio:['ignore','ignore','ignore']})
    child.once('error', () => reject(new Error(`PostgreSQL utility unavailable: ${program}`)))
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`PostgreSQL utility failed: ${program} (exit ${code})`)))
  })
}

export async function dumpPostgres(destination, env = process.env) {
  postgresConfig(env) // Validate the same TLS and connection settings as the application.
  fs.mkdirSync(path.dirname(destination), {recursive:true,mode:0o700})
  await run(env.PG_DUMP_BIN || 'pg_dump', ['--format=custom','--no-owner','--no-acl','--schema='+ (env.PGSCHEMA || 'public'),'--file='+destination], env)
  fs.chmodSync(destination,0o600)
}

export async function restorePostgres(source, env = process.env) {
  postgresConfig(env)
  await run(env.PG_RESTORE_BIN || 'pg_restore', ['--single-transaction','--exit-on-error','--clean','--if-exists','--no-owner','--no-acl','--dbname='+env.PGDATABASE,source], env)
}
