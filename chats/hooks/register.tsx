// Chats: every Claude chat on your account in one pane beside this one.
//
// The board shows one tile per chat (status, where it runs, what it is doing).
// Open a tile to read its latest messages and reply; from there, "Add beside"
// opens a second chat next to it. A chat that only shares with your trusted
// devices says so instead, and its reply box hides.
//
// Everything comes from the account's session server (`claude-code-remote`),
// called with the engine's own connection: list_sessions, list_events,
// send_message. Nothing here writes to disk or calls the network itself.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register, Timer } from 'claude-code'

import type { ChatStatus, ChatTile } from '../types'
import {
  ago,
  clip,
  isTrustRefusal,
  parseEvents,
  parseSessions,
  resultText,
  sortTiles,
} from './parse'

const PANE = 'chats'
const SERVER = 'claude-code-remote'
const REFRESH_MS = 15_000
const SESSION_LIMIT = 40
const EVENT_LIMIT = 60
const MAX_OPEN = 2
const MIN_TILE = 36
const SIDE_BY_SIDE_FROM = 90
const BESIDE_CHOICES = 5
const NOTE_MS = 4000
const OPEN_IN_APP = 'https://claude.ai/code/'
const TRUST_NOTE = 'This chat only shares its messages with your trusted devices.'

const tiles = atom({ plugin: 'chats', key: 'tiles' } as const, [])
const messages = atom({ plugin: 'chats', key: 'messages' } as const, {})
const openIds = atom({ plugin: 'chats', key: 'openIds' } as const, [])
const pins = atom({ plugin: 'chats', key: 'pins' } as const, [])
const showArchived = atom({ plugin: 'chats', key: 'showArchived' } as const, false)
const isLoading = atom({ plugin: 'chats', key: 'isLoading' } as const, false)
const error = atom({ plugin: 'chats', key: 'error' } as const, null)
const refreshedAt = atom({ plugin: 'chats', key: 'refreshedAt' } as const, null)
const sendNotes = atom({ plugin: 'chats', key: 'sendNotes' } as const, {})
const replyRound = atom({ plugin: 'chats', key: 'replyRound' } as const, {})
const sendBlocked = atom({ plugin: 'chats', key: 'sendBlocked' } as const, [])

/** The app's own theme colour for each status, so tiles match the app. */
const STATUS_COLOR: Record<ChatStatus, string> = {
  Working: 'claude',
  'Needs you': 'warning',
  Done: 'success',
  Failed: 'error',
  Idle: 'inactive',
  Archived: 'inactive',
}

// Module state. A hot reload starts it over and cancels the old timer;
// session.start or /chats starts a new one, and only one per load.
let isRefreshing = false
let ticker: Timer | undefined
/** The newest request per chat, so an older answer never overwrites a newer one. */
const latestRequest = new Map<string, number>()
let requestCount = 0
/** Chats with a send on its way; checked and set with no await between, so Enter twice sends once. */
const sending = new Set<string>()
/** Which note each chat shows, so a timer only clears its own note. */
const noteSeq = new Map<string, number>()

/** Calls the session server; a thrown error becomes an errored result. */
async function call(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    return await $.mcp.call(SERVER, tool, args)
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text }], isError: true }
  }
}

/** Starts the auto-refresh once. */
function startTicker($: EngineInterface) {
  if (ticker === undefined) ticker = $.clock.every(REFRESH_MS, () => void refresh($))
}

/** Re-reads the chat list, and the open chats' messages. Never throws. */
async function refresh($: EngineInterface) {
  if (isRefreshing) return
  try {
    isRefreshing = true
    await update($, isLoading, () => true)
    const result = await call($, 'list_sessions', { limit: SESSION_LIMIT, mine: true })
    const list = result.isError ? null : parseSessions(result)
    if (list === null) {
      const why = result.isError ? clip(resultText(result), 160) : 'the answer could not be read'
      await update($, error, () => `Could not load your chats: ${why}`)
    } else {
      await update($, tiles, () => list)
      await update($, error, () => null)
      await update($, refreshedAt, () => new Date(Date.now()).toISOString())
    }
    for (const id of await read($, openIds)) await loadMessages($, id)
  } catch {
    // A failed write is retried on the next tick; never let it stop the ticker.
  } finally {
    isRefreshing = false
    await update($, isLoading, () => false).catch(() => undefined)
  }
}

/** Reads one chat's latest messages, or why they can't be read here. */
async function loadMessages($: EngineInterface, id: string) {
  const mine = ++requestCount
  latestRequest.set(id, mine)
  const result = await call($, 'list_events', {
    session_id: id,
    kinds: ['user', 'assistant'],
    limit: EVENT_LIMIT,
  })
  if (latestRequest.get(id) !== mine) return
  const text = result.isError ? resultText(result) : ''
  const lines = result.isError ? null : parseEvents(result)
  const entry =
    lines !== null
      ? { lines }
      : isTrustRefusal(text)
        ? { lines: [], blocked: TRUST_NOTE }
        : { lines: [], error: `Could not load messages: ${clip(text || 'the answer could not be read', 160)}` }
  await update($, messages, all => ({ ...all, [id]: entry }))
}

/** Opens a chat full size. `beside` keeps the one already open next to it. */
async function openChat($: EngineInterface, id: string, beside: boolean) {
  await update($, openIds, list => {
    const kept = beside ? list.filter(o => o !== id) : []
    return [...kept, id].slice(-MAX_OPEN)
  })
  await loadMessages($, id)
}

async function closeChat($: EngineInterface, id: string) {
  await update($, openIds, list => list.filter(o => o !== id))
}

async function togglePin($: EngineInterface, id: string) {
  const next = await update($, pins, list =>
    list.includes(id) ? list.filter(p => p !== id) : [...list, id],
  )
  await $.store.set('pins', next)
}

async function send($: EngineInterface, id: string, text: string) {
  const message = text.trim()
  if (message === '' || sending.has(id)) return
  sending.add(id)
  try {
    await sendNow($, id, message)
  } finally {
    sending.delete(id)
  }
}

async function sendNow($: EngineInterface, id: string, message: string) {
  await update($, sendNotes, all => ({ ...all, [id]: 'Sending…' }))
  const result = await call($, 'send_message', { session_id: id, message })
  const reply = resultText(result)
  const refused = result.isError && isTrustRefusal(reply)
  const note = !result.isError
    ? 'Sent.'
    : refused
      ? 'Not sent: this chat only takes messages from your trusted devices.'
      : `Not sent: ${clip(reply, 120)}`
  await update($, sendNotes, all => ({ ...all, [id]: note }))
  if (refused) {
    await update($, sendBlocked, list => (list.includes(id) ? list : [...list, id]))
  }
  if (!result.isError) {
    // A new round draws a fresh, empty reply box.
    await update($, replyRound, all => ({ ...all, [id]: (all[id] ?? 0) + 1 }))
    $.clock.after(3000, () => void loadMessages($, id))
  }
  const seq = (noteSeq.get(id) ?? 0) + 1
  noteSeq.set(id, seq)
  $.clock.after(NOTE_MS, () => {
    if (noteSeq.get(id) !== seq) return
    void update($, sendNotes, all => {
      const rest = { ...all }
      delete rest[id]
      return rest
    })
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'chats',
      description: 'Show all your Claude chats side by side in a pane',
    })
    const saved = await $.store.get('pins')
    if (Array.isArray(saved)) {
      await update($, pins, () => saved.filter((p): p is string => typeof p === 'string'))
    }
    // Only open by itself where someone is looking.
    if (e.isInteractive) {
      $.ui.open({ id: PANE, title: 'Chats' }).catch(() => undefined)
      void refresh($)
      startTicker($)
    }

    return next(e)
  })

  on('command.run', { command: 'chats' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Chats', focus: true })
    startTicker($)
    void refresh($)

    return { text: 'Chats pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    // The phone app draws no text field yet, so it gets no reply box.
    const Input = 'Input' in ui ? ui.Input : undefined
    const now = Date.now()

    const all = await read($, tiles)
    const pinned = await read($, pins)
    const open = await read($, openIds)
    const problem = await read($, error)
    const lastGood = await read($, refreshedAt)
    const columns = e.viewport?.columns ?? 80
    const rows = e.viewport?.rows ?? 30

    const statusChip = (t: ChatTile) => (
      <Text color={STATUS_COLOR[t.status]} bold>
        ● {t.status}
      </Text>
    )
    const metaLine = (t: ChatTile) =>
      [
        t.place,
        t.isConnected ? '' : 'not connected',
        ago(t.updatedAt, now),
        t.isUnread ? 'unread' : '',
        pinned.includes(t.id) ? 'Pinned' : '',
      ]
        .filter(Boolean)
        .join(' · ')

    // ---- Open chats, side by side ----------------------------------------
    if (open.length > 0) {
      const boxes = await read($, messages)
      const notes = await read($, sendNotes)
      const rounds = await read($, replyRound)
      const cannotSend = await read($, sendBlocked)
      const isSideBySide = open.length > 1 && columns >= SIDE_BY_SIDE_FROM
      const stacked = open.length > 1 && !isSideBySide
      // Messages wrap, so allow about one message per two rows of room.
      const room = Math.max(2, Math.floor((stacked ? (rows - 16) / 2 : rows - 12) / 2))

      const column = (id: string) => {
        const t = all.find(c => c.id === id)
        const box = boxes[id]
        const note = notes[id]
        const lines = (box?.lines ?? []).slice(-room)
        const round = rounds[id] ?? 0
        return (
          <Box
            key={`chat-${id}`}
            flexDirection="column"
            flexGrow={1}
            width={isSideBySide ? '50%' : '100%'}
            borderStyle="round"
            borderColor={t?.status === 'Needs you' ? 'warning' : 'subtle'}
            paddingX={1}
            gap={1}
          >
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Box flexShrink={1} flexGrow={1}>
                <Text bold wrap="truncate-end">{t?.title ?? 'Chat'}</Text>
              </Box>
              <Box flexShrink={0} flexDirection="row" gap={1}>
                <Link href={`${OPEN_IN_APP}${id}`} label="Open in app" />
                <Button
                  key={`close-${id}`}
                  label={`Close ${t?.title ?? 'chat'}`}
                  dimColor
                  onPress={() => void closeChat($, id)}
                >
                  Close
                </Button>
              </Box>
            </Box>
            {t && (
              <Text dimColor wrap="truncate-end">
                {statusChip(t)} · {metaLine(t)}
              </Text>
            )}
            <Box flexDirection="column" rowGap={1} flexGrow={1} overflow="hidden">
              {box === undefined && <Text dimColor>Loading messages…</Text>}
              {box?.blocked && (
                <Text color="warning">{box.blocked} Use “Open in app” to read and reply there.</Text>
              )}
              {box?.error && <Text color="error">{box.error}</Text>}
              {box && !box.blocked && !box.error && lines.length === 0 && (
                <Text dimColor>No messages yet.</Text>
              )}
              {lines.map((line, i) => (
                <Text key={`line-${id}-${i}`} wrap="wrap">
                  <Text bold color={line.role === 'you' ? 'suggestion' : 'claude'}>
                    {line.role === 'you' ? 'You' : 'Claude'}:
                  </Text>{' '}
                  {clip(line.text, 280)}
                </Text>
              ))}
            </Box>
            {cannotSend.includes(id) && !box?.blocked && (
              <Text color="warning">This chat only takes messages from your trusted devices.</Text>
            )}
            {box !== undefined && !box.blocked && !cannotSend.includes(id) && Input && (
              <Input
                key={round === 0 ? `reply-${id}` : `reply-${id}-${round}`}
                placeholder="Reply…"
                submitLabel="Send"
                autoFocus={id === open[open.length - 1] ? true : undefined}
                onSubmit={(value: string) => void send($, id, value)}
              />
            )}
            {note && <Text dimColor>{note}</Text>}
          </Box>
        )
      }

      // With one chat open, offer the most relevant others to add beside it.
      const others =
        open.length === 1
          ? sortTiles(
              all.filter(t => t.status !== 'Archived' && !open.includes(t.id)),
              pinned,
            ).slice(0, BESIDE_CHOICES)
          : []

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button
              key="back"
              label="All chats"
              hotkey="b"
              variant="secondary"
              onPress={() => void update($, openIds, () => [])}
            >
              ← All chats
            </Button>
            {others.length > 0 && <Text dimColor>Add beside:</Text>}
            {others.map(t => (
              <Button
                key={`beside-${t.id}`}
                label={`Open ${t.title} beside this chat`}
                dimColor
                onPress={() => void openChat($, t.id, true)}
              >
                {clip(t.title, 24)}
              </Button>
            ))}
          </Box>
          <Box flexDirection={isSideBySide ? 'row' : 'column'} gap={1}>
            {open.map(column)}
          </Box>
        </Box>
      )
    }

    // ---- The board -------------------------------------------------------
    const withArchived = await read($, showArchived)
    const loading = await read($, isLoading)
    const visible = sortTiles(
      all.filter(t => withArchived || t.status !== 'Archived'),
      pinned,
    )
    const archived = all.filter(t => t.status === 'Archived').length
    const needYou = visible.filter(t => t.status === 'Needs you').length
    const perRow = Math.max(1, Math.floor((columns + 1) / (MIN_TILE + 1)))
    const width = perRow === 1 ? '100%' : Math.floor((columns - (perRow - 1)) / perRow)
    const summaryRoom = typeof width === 'number' ? width * 2 - 4 : 140
    const isFirstLoad = lastGood === null && problem === null
    const firstNeedsYou = visible.find(t => t.status === 'Needs you')?.id

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text dimColor>
            {needYou > 0 && (
              <Text color="warning" bold>
                {needYou} need{needYou === 1 ? 's' : ''} you ·{' '}
              </Text>
            )}
            {visible.length} {visible.length === 1 ? 'chat' : 'chats'}
            {loading ? ' · refreshing…' : lastGood ? ` · updated ${ago(lastGood, now)}` : ''}
          </Text>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {archived > 0 && (
              <Button
                key="archived"
                hotkey="a"
                dimColor
                label={withArchived ? 'Hide archived' : `Show archived (${archived})`}
                onPress={() => void update($, showArchived, v => !v)}
              />
            )}
            <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refresh($)} />
          </Box>
        </Box>

        {problem && (
          <Text color="error">
            {problem}
            {lastGood && all.length > 0 ? ` Showing the list from ${ago(lastGood, now)}.` : ''}
          </Text>
        )}

        {isFirstLoad && all.length === 0 && <Text dimColor>Loading your chats…</Text>}

        {!isFirstLoad && !problem && visible.length === 0 && (
          <Text dimColor>
            No chats yet. Chats from the Claude app, and from other computers with Remote Control on,
            appear here.
          </Text>
        )}

        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {visible.map((t, i) => {
            const isPinned = pinned.includes(t.id)
            const needsYou = t.status === 'Needs you'
            return (
              <Box
                key={`tile-${t.id}`}
                flexDirection="column"
                width={width}
                minHeight={6}
                borderStyle="round"
                borderColor={needsYou ? 'warning' : 'subtle'}
                paddingX={1}
              >
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Box flexShrink={1} flexGrow={1}>
                    <Text bold wrap="truncate-end">{t.title}</Text>
                  </Box>
                  <Box flexShrink={0}>{statusChip(t)}</Box>
                </Box>
                <Text dimColor wrap="truncate-end">{metaLine(t)}</Text>
                {t.summary ? (
                  <Text wrap="wrap">{clip(t.summary, summaryRoom)}</Text>
                ) : (
                  <Text dimColor>No summary yet</Text>
                )}
                <Box flexDirection="row" gap={1}>
                  <Button
                    key={`open-${t.id}`}
                    label={`Open ${t.title}`}
                    variant={needsYou ? 'primary' : 'secondary'}
                    hotkey={i < 9 ? String(i + 1) : undefined}
                    autoFocus={t.id === firstNeedsYou ? true : undefined}
                    onPress={() => void openChat($, t.id, false)}
                  >
                    Open
                  </Button>
                  <Button
                    key={`pin-${t.id}`}
                    label={`${isPinned ? 'Unpin' : 'Pin'} ${t.title}`}
                    dimColor
                    onPress={() => void togglePin($, t.id)}
                  >
                    {isPinned ? 'Unpin' : 'Pin'}
                  </Button>
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
