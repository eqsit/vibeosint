# VibeOSINT

[🇷🇺 Читать на русском](README_RU.md)

Obsidian plugin for visual OSINT investigations on Canvas. You give it a target,
[Hermes Agent](https://hermes-agent.nousresearch.com) does the research, and the
findings land on your Canvas as a tree of linked cards.

## Features

- **Canvas as the report** — findings become nodes and edges, laid out left to right, auto-sized, no overlaps.
- **Hermes ACP** — autonomous web search, page extraction, browser, Python. Runs locally, on a server over SSH, or via any ACP stdio command.
- **Deep mode** — the agent expands every lead into its own branch and keeps digging until new queries stop yielding new facts.
- **Chat per Canvas** — streaming replies, visible tool steps, message editing with branches, follow-ups while the agent works.
- **Smart updates** — existing cards are updated as facts firm up instead of piling up duplicates.
- **Proxy routing** — a SOCKS5H proxy for geo-blocks and Cloudflare, without DNS leaks.
- **Local** — everything stays in your vault. No telemetry.

## Install

1. Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/vibeosint/`.
2. Restart Obsidian, enable the plugin in **Settings → Community plugins**.
3. Open the plugin settings and set up the Hermes ACP connection.

No build step. Desktop only. When updating, keep your `data.json` and `chats.json`.

## Configure

Pick a transport in the plugin settings:

| Transport | What you need |
| --- | --- |
| **Local Hermes · stdio** | Hermes installed on this machine. Leave the command empty for autodetection. |
| **External Hermes · SSH** | Hermes on a server, key-based SSH from this machine. Set host and an absolute working directory on the server. |
| **Custom command · stdio** | Any executable speaking line-delimited JSON-RPC ACP on stdout. |

Then hit **Apply and test**. Leave the model field empty to use whatever Hermes is
configured with, or set a model ID your installation accepts.

Full setup guide, proxy and troubleshooting: [README_RU.md](README_RU.md).

## Use

1. Open or create a `.canvas` file.
2. Open the **OSINT Canvas Agent** sidebar (crosshair icon in the ribbon).
3. Type the target — username, phone, domain, company, person.
4. Watch the graph build itself. Toggle **DEEP** for saturation research.

Chat commands: `/model <id>`, `/reset` (new session), `/clear` (wipe history),
`/new` (new canvas), `/align` (re-layout), `/stop`. Adding `/deep` to a message
turns on saturation research for that one request.

## License

MIT — see [LICENSE](LICENSE).
