# Chats — all your Claude chats in one pane

A mod for Claude Code and the Claude desktop app. It adds a **Chats** pane beside
your conversation, so you can watch several chats at once without opening
another window or app.

- One tile per chat: name, status (**Working**, **Needs you**, **Done**, **Idle**,
  **Failed**), where it runs, when it last moved, and what it is doing.
- Chats that need you come first. **Pin** the ones you care about; pins are kept.
- **Open** a tile to read its latest messages and reply from the pane.
- Refreshes by itself every 15 seconds, or press **Refresh**.
- Type `/chats` to bring the pane back.

## Install

In a terminal:

```
/plugin install chats --marketplace wei2x13/laymen-modpack
```

Answer `y` to add the marketplace, then pick the **user** scope. It is then on in
every new session, including the desktop app's Code tab.

## Which chats show up

Every chat on your Claude account that the session can list: cloud chats, and
chats on your other PCs that run with **Remote Control** on (started from the
Claude desktop app, or with `claude remote-control` in a terminal).

## Reading and replying

Chats on your PCs only share their messages with your **trusted devices**. When
the pane runs somewhere that isn't one of them, the tile still shows the status
and summary, and the open view says "This chat only shares its messages with
your trusted devices" and hides the reply box. Use **Open in app** there.

## Develop

```
claude plugin validate .
claude plugin test .
```
