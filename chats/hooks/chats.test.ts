import { expect, mock, test } from 'claude-code/testing'
import type { McpToolResult, On } from 'claude-code'

const ROG = 'session_01rog'
const NOCTUA = 'session_01noctua'

const PANE = {
  plugin: 'chats',
  component: 'Pane',
  requestId: 'chats',
  props: {
    title: 'Chats',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
  viewport: { columns: 100, rows: 30 },
} as const

/** A server answer wrapped the way the real one wraps another session's data. */
const wrapped = (json: unknown): McpToolResult => ({
  content: [
    { type: 'text', text: `<other-session nonce="x">\nNotice line.\n${JSON.stringify(json)}\n</other-session nonce="x">` },
  ],
  isError: false,
})

const SESSIONS = wrapped({
  ccr: {
    data: [
      {
        id: ROG,
        title: 'rog - programmer',
        session_status: 'SESSION_STATUS_REQUIRES_ACTION',
        status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
        updated_at: '2026-10-09T03:00:00Z',
        environment_kind: 'bridge',
        connection_status: 'connected',
        unread: true,
      },
      {
        id: NOCTUA,
        title: 'noctua - programmer',
        session_status: 'SESSION_STATUS_IDLE',
        status_bucket: 'SESSION_STATUS_BUCKET_REVIEW_READY',
        updated_at: '2026-09-29T19:29:26Z',
        environment_kind: 'bridge',
        connection_status: 'disconnected',
        post_turn_summary: { status_detail: 'tests pass, 4 commits to push' },
      },
      { id: 'session_01old', title: 'old one', session_status: 'SESSION_STATUS_ARCHIVED' },
    ],
  },
})

const EVENTS = wrapped({
  ccr: {
    data: [
      { user: { internal_anthropic_catchall: { message: { role: 'user', content: 'fix the score bug' } } } },
      {
        assistant: {
          internal_anthropic_catchall: {
            message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it in scoring.ts.' }] },
          },
        },
      },
    ],
  },
})

type Sent = { tool: string; args: Record<string, unknown> }

type Server = {
  sessions?: () => McpToolResult
  events?: (id: string) => McpToolResult
  send?: () => McpToolResult
}

const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }], isError: false })
const bad = (text: string): McpToolResult => ({ content: [{ type: 'text', text }], isError: true })
const TRUST = 'non-retryable (elevated_session_untrusted_device): only trusted devices'

/** Stands in for the session server and records every call. */
const fakeServer = (on: On, server: Server = {}): Sent[] => {
  const calls: Sent[] = []
  const answer = (name: string, tool: string, args: Record<string, unknown>): McpToolResult => {
    calls.push({ tool, args })
    if (name !== 'claude-code-remote') return bad('no such server')
    if (tool === 'list_sessions') return (server.sessions ?? (() => SESSIONS))()
    if (tool === 'list_events') return (server.events ?? (() => EVENTS))(String(args.session_id))
    if (tool === 'send_message') return (server.send ?? (() => ok('delivered')))()
    return bad('unknown tool')
  }
  on('mcp.call', ($, e) => ({ value: answer(e.server, e.tool, e.args) }))
  return calls
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the board lists chats, needing-you first, archived hidden`, async ($, on) => {
    mock.clock(on)
    fakeServer(on)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /Loading your chats/ })).toBeDefined()
    await ui.press({ key: 'refresh' })

    const titles = await ui.findAll({ type: 'Text', text: /- programmer/ })
    expect(titles.map(t => t.text)).toEqual(['rog - programmer', 'noctua - programmer'])
    expect(await ui.find({ type: 'Text', text: /1 needs you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /4 commits to push/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /old one/ })).toBeUndefined()

    await ui.press({ key: 'archived' })
    expect(await ui.find({ type: 'Text', text: /old one/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: opening a chat shows its messages; a reply sends once and clears`, async ($, on) => {
    mock.clock(on)
    const calls = fakeServer(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: `open-${ROG}` })

    expect(await ui.find({ type: 'Text', text: /fix the score bug/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Fixed it in scoring.ts/ })).toBeDefined()

    await ui.input({ key: `reply-${ROG}`, text: 'also add a test' })
    const sent = calls.filter(c => c.tool === 'send_message')
    expect(sent.map(c => c.args)).toEqual([{ session_id: ROG, message: 'also add a test' }])
    expect(await ui.find({ type: 'Text', text: /Sent\./ })).toBeDefined()
    // A fresh, empty reply box replaces the used one.
    expect(await ui.find({ key: `reply-${ROG}` })).toBeUndefined()
    expect(await ui.find({ key: `reply-${ROG}-1` })).toBeDefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /noctua - programmer/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: two chats open side by side, each with its own reply box`, async ($, on) => {
    mock.clock(on)
    fakeServer(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: `open-${ROG}` })
    await ui.press({ key: `beside-${NOCTUA}` })

    expect(await ui.find({ key: `chat-${ROG}` })).toBeDefined()
    expect(await ui.find({ key: `chat-${NOCTUA}` })).toBeDefined()
    expect(await ui.find({ key: `reply-${ROG}` })).toBeDefined()
    expect(await ui.find({ key: `reply-${NOCTUA}` })).toBeDefined()

    await ui.press({ key: `close-${ROG}` })
    expect(await ui.find({ key: `chat-${ROG}` })).toBeUndefined()
    expect(await ui.find({ key: `chat-${NOCTUA}` })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a chat that only trusts its owner's devices says so and hides the reply box`, async ($, on) => {
    mock.clock(on)
    fakeServer(on, { events: () => bad(TRUST) })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: `open-${ROG}` })

    expect(await ui.find({ type: 'Text', text: /trusted devices/ })).toBeDefined()
    expect(await ui.find({ key: `reply-${ROG}` })).toBeUndefined()
    await ui.unmount()
  })
}

test('a send the chat refuses for trust hides the reply box', async ($, on) => {
  mock.clock(on)
  fakeServer(on, { send: () => bad(TRUST) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `open-${ROG}` })
  await ui.input({ key: `reply-${ROG}`, text: 'hi' })

  expect(await ui.find({ type: 'Text', text: /Not sent: this chat only takes messages/ })).toBeDefined()
  expect(await ui.find({ key: `reply-${ROG}` })).toBeUndefined()

  // A later refresh that can still read the messages must not bring the box back.
  await ui.press({ key: 'back' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `open-${ROG}` })
  expect(await ui.find({ type: 'Text', text: /fix the score bug/ })).toBeDefined()
  expect(await ui.find({ key: `reply-${ROG}` })).toBeUndefined()
  await ui.unmount()
})

test('pins are saved and pinned chats come first', async ($, on) => {
  mock.clock(on)
  const saved: unknown[] = []
  on('store.set', ($, e) => {
    if (e.key === 'pins') saved.push(e.value)
    return { value: undefined }
  })
  fakeServer(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `pin-${NOCTUA}` })

  expect(await ui.find({ type: 'Text', text: /Pinned/ })).toBeDefined()
  const titles = await ui.findAll({ type: 'Text', text: /- programmer/ })
  expect(titles[0]?.text).toContain('noctua')
  expect(saved).toEqual([[NOCTUA]])
  await ui.unmount()
})

test('the list refreshes by itself every 15 seconds after session start', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const calls = fakeServer(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const before = calls.filter(c => c.tool === 'list_sessions').length
  expect(before).toBeGreaterThan(0)

  await clock.advance(15_000)
  await clock.settle()
  expect(calls.filter(c => c.tool === 'list_sessions').length).toBeGreaterThan(before)
})

test('a server that cannot be reached shows one clear error', async ($, on) => {
  mock.clock(on)
  fakeServer(on, { sessions: () => bad('server not connected') })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ type: 'Text', text: /Could not load your chats: server not connected/ })).toBeDefined()
  await ui.unmount()
})

test('an answer that cannot be read is an error, not an empty list', async ($, on) => {
  mock.clock(on)
  fakeServer(on, { sessions: () => ok('Notice {with braces} but no data') })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ type: 'Text', text: /the answer could not be read/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No chats yet/ })).toBeUndefined()
  await ui.unmount()
})
