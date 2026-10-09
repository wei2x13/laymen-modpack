/** How a chat is doing, in the app's own words. */
export type ChatStatus = 'Working' | 'Needs you' | 'Done' | 'Idle' | 'Failed' | 'Archived'

/** One chat on the board, read from the account's session list. */
export type ChatTile = {
  id: string
  title: string
  status: ChatStatus
  /** ISO time of the chat's last activity. */
  updatedAt: string
  /** One line on what the chat is doing or did last; '' when none. */
  summary: string
  /** Where it runs: 'Your PC', 'Cloud' or 'Other'. */
  place: string
  isConnected: boolean
  isUnread: boolean
}

/** One line of a chat's transcript as the pane shows it. */
export type ChatLine = { role: 'you' | 'claude'; text: string }

/**
 * What the pane knows about one chat's messages. `blocked` is set when the
 * chat refused to share with this device (Remote Control chats only share
 * with the owner's trusted devices); the pane then hides the reply box.
 */
export type ChatMessages = {
  lines: ChatLine[]
  blocked?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    chats: {
      tiles: ChatTile[]
      messages: Record<string, ChatMessages>
      /** The chats open full size, at most two, shown side by side. Empty = the board. */
      openIds: string[]
      pins: string[]
      showArchived: boolean
      isLoading: boolean
      /** Why the last refresh failed, or null. */
      error: string | null
      /** ISO time of the last good refresh, or null before the first one. */
      refreshedAt: string | null
      /** A short note per chat after a send ("Sending…", "Sent." or why not). */
      sendNotes: Record<string, string>
      /** Chats that refused a reply from this device; a message reload never clears it. */
      sendBlocked: string[]
      /**
       * How many replies each chat has had from this pane. It is part of the
       * reply box's key, so a new box (empty) is drawn after each send while
       * typing is never overwritten by a redraw.
       */
      replyRound: Record<string, number>
    }
  }
}
