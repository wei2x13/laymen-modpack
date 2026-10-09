# Laymen modpack

Mods for Claude Code and the Claude desktop app, written to be simple to use.

There are no mods in the pack yet.

## Install a mod

In a terminal running Claude Code, type:

```
/plugin install <mod> --marketplace wei2x13/laymen-modpack
```

Answer `y` to add the marketplace, then pick the **user** scope.

## Adding a mod

Each mod lives in its own folder with `.claude-plugin/plugin.json` and a `hooks/`
folder, and gets one line in `.claude-plugin/marketplace.json`. Check it with:

```
claude plugin validate <folder>
claude plugin test <folder>
```
