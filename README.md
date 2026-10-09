# Laymen modpack

Mods for Claude Code and the Claude desktop app, written to be simple to use.

## Install

In a terminal running Claude Code, type the line for the mod you want:

```
/plugin install chats --marketplace wei2x13/laymen-modpack
```

Answer `y` to add the marketplace, then pick the **user** scope. The mod is then on
in every new session, including the desktop app's Code tab.

## Mods

| Mod | What it does |
| --- | --- |
| [chats](./chats) | All your Claude chats in one pane beside the one you're in. See which need you, read their latest messages, reply, and open two side by side. |

## Adding a mod

Each mod lives in its own folder with `.claude-plugin/plugin.json` and a `hooks/`
folder, and gets one line in `.claude-plugin/marketplace.json`. Check it with:

```
claude plugin validate <folder>
claude plugin test <folder>
```
