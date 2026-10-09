// Turns what the session server answers into the plain values the pane draws.
// Kept apart from register.tsx so the tests can check it without a pane.

import type { McpToolResult } from 'claude-code'

import type { ChatLine, ChatStatus, ChatTile } from '../types'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The text of a tool result, all text blocks joined. */
export const resultText = (r: McpToolResult): string =>
  (r.content ?? []).map(b => (b.type === 'text' ? b.text : '')).join('\n')

const tryObject = (text: string): Json | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The JSON inside a result, or null when there is none. The server wraps
 * another session's data in notice lines around the JSON, so try the whole
 * text, then each line that starts with `{`, then first `{` to last `}`.
 */
export const resultJson = (r: McpToolResult): Json | null => {
  if (isObject(r.structuredContent)) return r.structuredContent
  const text = resultText(r)
  const whole = tryObject(text.trim())
  if (whole) return whole
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('{')) {
      const found = tryObject(line.trim())
      if (found) return found
    }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? tryObject(text.slice(start, end + 1)) : null
}

/** The `data` array the server answers with, under `ccr` or at the top; null when the answer can't be read. */
const dataOf = (json: Json | null): unknown[] | null => {
  if (json === null) return null
  const inner = isObject(json.ccr) ? json.ccr : json
  return Array.isArray(inner.data) ? inner.data : null
}

const BUCKETS: Record<string, ChatStatus> = {
  SESSION_STATUS_BUCKET_WORKING: 'Working',
  SESSION_STATUS_BUCKET_BLOCKED: 'Needs you',
  SESSION_STATUS_BUCKET_REVIEW_READY: 'Done',
  SESSION_STATUS_BUCKET_COMPLETED: 'Done',
  SESSION_STATUS_BUCKET_FAILED: 'Failed',
}

export const statusOf = (s: Json): ChatStatus => {
  if (str(s.session_status) === 'SESSION_STATUS_ARCHIVED') return 'Archived'
  return BUCKETS[str(s.status_bucket)] ?? 'Idle'
}

const placeOf = (kind: string): string =>
  kind === 'bridge' ? 'Your PC' : kind === 'anthropic_cloud' ? 'Cloud' : 'Other'

/** The best one-line summary the server offers for a chat. */
const summaryOf = (s: Json): string => {
  const meta = isObject(s.external_metadata) ? s.external_metadata : {}
  const turn = isObject(s.post_turn_summary) ? s.post_turn_summary : {}
  const line =
    str(turn.needs_action) ||
    str(turn.status_detail) ||
    str(turn.recent_action) ||
    str(s.task_summary) ||
    str(meta.task_summary)
  return line.replace(/\s+/g, ' ').trim()
}

/** Every chat in a `list_sessions` answer, as tiles; null when the answer can't be read. */
export const parseSessions = (r: McpToolResult): ChatTile[] | null =>
  dataOf(resultJson(r))
    ?.filter(isObject)
    .filter(s => str(s.id) !== '')
    .map(s => ({
      id: str(s.id),
      title: str(s.title) || 'Untitled chat',
      status: statusOf(s),
      updatedAt: str(s.updated_at),
      summary: summaryOf(s),
      place: placeOf(str(s.environment_kind)),
      isConnected: str(s.connection_status) === 'connected',
      isUnread: s.unread === true,
    })) ?? null

/** The readable text of one message's content: text blocks, and a note per tool used. */
const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isObject)
    .map(b => {
      if (b.type === 'text') return str(b.text)
      if (b.type === 'tool_use') return `(used ${str(b.name) || 'a tool'})`
      return ''
    })
    .filter(t => t !== '')
    .join('\n')
}

/** The user and Claude lines of a `list_events` answer, oldest first; null when it can't be read. */
export const parseEvents = (r: McpToolResult): ChatLine[] | null => {
  const data = dataOf(resultJson(r))
  if (data === null) return null
  const lines: ChatLine[] = []
  for (const ev of data.filter(isObject)) {
    const role = isObject(ev.user) ? 'you' : isObject(ev.assistant) ? 'claude' : null
    if (role === null) continue
    const body = (role === 'you' ? ev.user : ev.assistant) as Json
    const holder = isObject(body.internal_anthropic_catchall) ? body.internal_anthropic_catchall : body
    const message = isObject(holder.message) ? holder.message : holder
    const text = contentText(message.content).trim()
    if (text === '') continue
    const last = lines.at(-1)
    // Tool calls arrive one event each; fold a run of them into one line.
    if (last && last.role === role && text.startsWith('(used ') && last.text.startsWith('(used ')) {
      last.text = `${last.text} ${text}`
      continue
    }
    lines.push({ role, text })
  }
  return lines
}

/** True when the server refused because this device is not trusted by the chat. */
export const isTrustRefusal = (text: string): boolean => /trusted device|untrusted_device/i.test(text)

/** "just now", "5m ago", "3h ago", "2d ago" from an ISO time. */
export const ago = (iso: string, now: number): string => {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Pinned first, then chats that need you, then newest first. */
export const sortTiles = (tiles: ChatTile[], pins: string[]): ChatTile[] => {
  const rank = (t: ChatTile) => (pins.includes(t.id) ? 0 : t.status === 'Needs you' ? 1 : 2)
  const time = (t: ChatTile) => Date.parse(t.updatedAt) || 0
  return [...tiles].sort((a, b) => rank(a) - rank(b) || time(b) - time(a))
}

/** Cut a long text to `max` characters on one line. */
export const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
