# Web Browser compatibility build

This is a local compatibility patch for the Obsidian community plugin whose ID is `web-browser`.

## Installation

1. Close Obsidian completely.
2. Open your vault's `.obsidian/plugins/web-browser/` directory.
3. Back up the old `main.js`, `manifest.json`, and `styles.css`.
4. Replace them with the three files in this package.
5. Start Obsidian, then disable and re-enable **Web Browser** under Community plugins.
6. Use the globe icon in the left ribbon, or run **Web Browser: 打开网页浏览器** from the command palette.

## Main compatibility changes

- Removed the deleted `electron.remote` API.
- Removed reliance on the removed `<webview>` `new-window` event.
- Removed brittle access to private Obsidian header child indexes.
- Added a browser toolbar with back, forward, reload, home, address/search, and external-open controls.
- Added a safe iframe fallback when the current Obsidian build does not expose Electron's `<webview>` tag.
- Fixed localhost, IP address, URL encoding, and Windows local HTML path handling.

## Limitation

Some websites deliberately prevent embedding, require a dedicated popup, or use anti-bot/login protections. Use the external-open button for those sites.
