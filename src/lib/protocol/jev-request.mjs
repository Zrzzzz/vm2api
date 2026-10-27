import { createHash } from 'node:crypto'
import { classifyJev, normalizeJevConfig } from './jev-intercept.mjs'
import { prepareInterceptText, stripReminders } from './jev-prepare.mjs'
import { classifyClaudeRequestPurpose } from './request-purpose.mjs'

const approvedSystems = new Map()
const requestVerdicts = new WeakMap()
const CACHE_TTL = 24 * 60 * 60 * 1000
const CACHE_LIMIT = 512
const VERSION = 'split-system-current-v1'
const hash = (text) => createHash('sha256').update(text).digest('hex')

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => ['text', 'input_text'].includes(part?.type))
    .map((part) => part.text || '')
    .join('\n')
}

/** Use the original client request, not the outbound rewritten body. */
export function jevRequestDocuments(inbound, { official = false, stripUserReminders = true } = {}) {
  const body = inbound || {}
  const systems = [textOf(body.system), textOf(body.instructions)]
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
  for (const message of messages) {
    if (['system', 'developer'].includes(message?.role)) systems.push(textOf(message.content))
  }
  const system = [...new Set(systems.filter(Boolean))].join('\n')
  const purpose = classifyClaudeRequestPurpose(body, { officialTraffic: official })
  if (purpose?.purpose === 'auto_mode_classifier') {
    const transcript = messages.map((m) => textOf(m.content)).join('')
    const close = transcript.lastIndexOf('</transcript>')
    const open = close < 0 ? -1 : transcript.lastIndexOf('<transcript>', close)
    const content = open < 0 ? transcript : transcript.slice(open + '<transcript>'.length, close)
    const action = content.trim().split('\n').at(-1)?.trim()
    if (!action) throw new Error('Jev: classifier has no current action')
    return { system, instruction: action, source: 'classifier_action' }
  }
  if (typeof body.input === 'string') return { system, instruction: body.input, source: 'user_instruction' }
  // Tool-result-only turns do not replace the user's latest instruction.
  // Consecutive textual user messages form one current instruction batch.
  const current = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'assistant' && current.length) break
    if (message?.role !== 'user' && !(message?.type === 'message' && !message.role)) continue
    const raw = textOf(message.content)
    const text = stripUserReminders ? stripReminders(raw) : raw
    if (text.trim()) current.unshift(text)
  }
  return { system, instruction: current.join('\n'), source: 'user_instruction' }
}

/** No tail truncation: judge every chunk, with overlap across boundaries. */
async function judgeDocument(text, config, fetchImpl) {
  const prepared = prepareInterceptText(text, { stripReminders: false, expandBase64: config.expand_base64 })
  if (!prepared) return { action: 'pass', reason: 'safe', chunks: 0 }
  const size = config.max_state_chars
  const overlap = Math.min(256, Math.floor(size / 4))
  let chunks = 0
  for (let offset = 0; offset < prepared.length; offset += size - overlap) {
    const piece = prepared.slice(offset, offset + size)
    const verdict = await classifyJev(piece, { ...config, strip_reminders: false, expand_base64: false }, fetchImpl)
    chunks++
    if (verdict.action !== 'pass' || verdict.reason !== 'safe') return { ...verdict, chunks }
    if (offset + size >= prepared.length) break
  }
  return { action: 'pass', reason: 'safe', chunks }
}

/**
 * @returns {Promise<{action: string, reason?: string, category?: string, categories?: string[], detail?: string, audit: {version: string, system: {fingerprint: string, chars: number, status: string, chunks?: number}, instruction: {source: string, chars: number, status: string, chunks?: number}}}>}
 */
export async function classifyJevRequest(
  inbound,
  cfg,
  { official = false, fetchImpl = globalThis.fetch, now = Date.now(), requestId = '' } = {},
) {
  const config = normalizeJevConfig(cfg)
  const docs = jevRequestDocuments(inbound, { official, stripUserReminders: config.strip_reminders })
  const requestKey = hash(JSON.stringify([VERSION, config, docs]))
  const previous = inbound && requestId ? requestVerdicts.get(inbound) : null
  if (previous?.requestId === requestId && previous?.key === requestKey) return previous.verdict
  const fingerprint = hash(docs.system)
  const audit = {
    version: VERSION,
    system: { fingerprint, chars: docs.system.length, status: 'empty' },
    instruction: { source: docs.source, chars: docs.instruction.length, status: 'pending' },
  }
  if (!config.enabled) return { action: 'pass', reason: 'skip', audit }
  const key = hash(JSON.stringify([VERSION, config, fingerprint]))
  if (docs.system) {
    if (config.trusted_system_hashes.includes(fingerprint)) {
      audit.system.status = 'trusted_hash'
    } else if ((approvedSystems.get(key) || 0) > now) {
      audit.system.status = 'cached_pass'
    } else {
      const verdict = await judgeDocument(docs.system, config, fetchImpl)
      audit.system.status = verdict.action === 'block' ? 'block' : verdict.reason === 'safe' ? 'judged_pass' : 'error'
      audit.system.chunks = verdict.chunks
      if (verdict.action !== 'pass' || verdict.reason !== 'safe') return { ...verdict, audit }
      if (approvedSystems.size >= CACHE_LIMIT) approvedSystems.delete(approvedSystems.keys().next().value)
      approvedSystems.set(key, now + CACHE_TTL)
    }
  }
  const verdict = await judgeDocument(docs.instruction, config, fetchImpl)
  audit.instruction.status = verdict.action === 'block' ? 'block' : verdict.reason === 'safe' ? 'judged_pass' : 'error'
  audit.instruction.chunks = verdict.chunks
  const result = { ...verdict, audit }
  if (inbound && requestId && verdict.action === 'pass' && verdict.reason === 'safe') {
    requestVerdicts.set(inbound, { requestId, key: requestKey, verdict: result })
  }
  return result
}
