/**
 * cluster_nodes repository — SSH-reachable VPS nodes.
 * Credentials are encrypted at rest via maybeEncrypt and never leave through
 * `list()` / `get()`; only `getSecrets()` returns them, for the connector.
 */

import { getDb } from '../../../database.mjs'
import { maybeDecrypt, maybeEncrypt } from '../../../secure.mjs'

const PUBLIC_COLUMNS = [
  'id',
  'label',
  'host',
  'port',
  'username',
  'auth_type',
  'host_key_alg',
  'host_key_sha256',
  'jump_node_id',
  'created_at',
  'updated_at',
]

function nextUpdatedAt(expectedUpdatedAt) {
  const previousMs = Date.parse(expectedUpdatedAt)
  if (!Number.isFinite(previousMs)) return null
  return new Date(Math.max(Date.now(), previousMs + 1)).toISOString()
}

export class ClusterNodesRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = "SELECT id, label, host, port, username, auth_type, host_key_alg, host_key_sha256, jump_node_id, platform, created_at, updated_at FROM cluster_nodes ORDER BY created_at, id"
    this._get = "SELECT id, label, host, port, username, auth_type, host_key_alg, host_key_sha256, jump_node_id, platform, created_at, updated_at FROM cluster_nodes WHERE id = $1"
    this._secrets = "SELECT password, private_key, passphrase FROM cluster_nodes WHERE id = $1"
    this._findEndpoint = "SELECT id FROM cluster_nodes WHERE host = $1 AND port = $2 AND username = $3"
    this._dependents = "SELECT id FROM cluster_nodes WHERE jump_node_id = $1"
    this._insert = "\n      INSERT INTO cluster_nodes (id, label, host, port, username, auth_type, password, private_key, passphrase,\n        host_key_alg, host_key_sha256, jump_node_id, created_at, updated_at)\n      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)\n    "
    this._update = "\n      UPDATE cluster_nodes SET label = $1, host = $2, port = $3, username = $4, auth_type = $5,\n        password = $6, private_key = $7, passphrase = $8, updated_at = $9\n      WHERE id = $10 AND updated_at = $11\n      RETURNING id, label, host, port, username, auth_type, host_key_alg, host_key_sha256, jump_node_id, platform, created_at, updated_at\n    "
    this._updateLabel = "\n      UPDATE cluster_nodes SET label = $1, updated_at = $2\n      WHERE id = $3 AND updated_at = $4\n      RETURNING id, label, host, port, username, auth_type, host_key_alg, host_key_sha256, jump_node_id, platform, created_at, updated_at\n    "
    this._remove = "DELETE FROM cluster_nodes WHERE id = $1"
  }

  async list() {
    return (await this.db.query(this._list, [])).rows.map((row) => ({ ...row }))
  }

  async get(id) {
    const row = (await this.db.query(this._get, [id])).rows[0]
    return row ? { ...row } : null
  }

  async findByEndpoint(host, port, username) {
    return (await this.db.query(this._findEndpoint, [host, port, username])).rows[0]?.id || null
  }

  async dependentsOf(id) {
    return (await this.db.query(this._dependents, [id])).rows.map((row) => row.id)
  }

  async getSecrets(id) {
    const row = (await this.db.query(this._secrets, [id])).rows[0]
    if (!row) return null
    return {
      password: maybeDecrypt(row.password),
      privateKey: maybeDecrypt(row.private_key),
      passphrase: maybeDecrypt(row.passphrase),
    }
  }

  async insert(node, now = new Date().toISOString()) {
    ;(await this.db.query(this._insert, [node.id, node.label, node.host, node.port, node.username, node.auth_type, maybeEncrypt(node.password ?? null), maybeEncrypt(node.private_key ?? null), maybeEncrypt(node.passphrase ?? null), node.host_key_alg, node.host_key_sha256, node.jump_node_id ?? null, now, now]))
    return (await this.get(node.id))
  }

  /** Replace normalized connection fields only if the caller's version is still current. */
  async update(id, node, expectedUpdatedAt) {
    const now = nextUpdatedAt(expectedUpdatedAt)
    if (!now) return null
    const row = (await this.db.query(this._update, [node.label, node.host, node.port, node.username, node.auth_type, maybeEncrypt(node.password ?? null), maybeEncrypt(node.private_key ?? null), maybeEncrypt(node.passphrase ?? null), now, id, expectedUpdatedAt])).rows[0]
    return row ? { ...row } : null
  }

  /** Rename without reading, decrypting or rewriting stored credentials. */
  async updateLabel(id, label, expectedUpdatedAt) {
    const now = nextUpdatedAt(expectedUpdatedAt)
    if (!now) return null
    const row = (await this.db.query(this._updateLabel, [label, now, id, expectedUpdatedAt])).rows[0]
    return row ? { ...row } : null
  }

  async remove(id) {
    return (await this.db.query(this._remove, [id])).rowCount > 0
  }

  async platform(id) { return (await this.db.table('cluster_nodes').where({id}).first('platform'))?.platform ?? null }
  async setPlatform(id, platform) { return (await this.db.table('cluster_nodes').where({id}).update({platform})) > 0 }
  async directLinks() {
    const rows = await this.db.table('cluster_node_direct_links').select('node_id','address','port')
    return new Map(rows.map(row => [row.node_id, {address:row.address,port:row.port}]))
  }
  async getDirectLink(id) {
    const row = await this.db.table('cluster_node_direct_links').where({node_id:id}).first()
    return row ? {address:row.address,port:row.port,token:maybeDecrypt(row.token),certSha256:row.cert_sha256 || null} : null
  }
  async setDirectLink(id, {address,port,token}, now = new Date().toISOString()) {
    const row = {node_id:id,address,port,token:maybeEncrypt(token),updated_at:now}
    await this.db.table('cluster_node_direct_links').insert(row).onConflict('node_id').merge(['address','port','token','updated_at'])
  }
  async setDirectLinkCert(id, certSha256) { await this.db.table('cluster_node_direct_links').where({node_id:id}).update({cert_sha256:certSha256}) }
  async clearDirectLink(id) { return (await this.db.table('cluster_node_direct_links').where({node_id:id}).delete()) > 0 }
}
