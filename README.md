# External Hermes ACP edition · 1.2.1

Ready-to-install Obsidian plugin. Supports local Hermes, remote Hermes over SSH,
and custom ACP stdio commands. The configured Hermes model is used by default.

**Installation and configuration: [README_RU.md](README_RU.md).**
Extract the plugin folder into `<vault>/.obsidian/plugins/`, enable the plugin,
select SSH in settings and click Apply and test. No npm/build step is needed.
Preserve any existing `data.json` and `chats.json` when updating.

Source: https://github.com/eqsit/vibeosint at commit
`6bacb58210fe57256d1d11ed67d6752c1c10cc2a`.
This is a modified archive; no GitHub fork or upstream changes were created.

The SSH transport launches a remote ACP process over stdio. It is not an HTTP
or WebSocket client. Canvas files stay in Obsidian; only their text context and
the user prompt are sent, and returned JSON actions are applied locally.
Credentials and tools come from the user's Hermes installation.

---

## Project overview

# VibeOSINT (Obsidian Plugin)

[🇷🇺 Читать на русском](README_RU.md)

**VibeOSINT** is an Obsidian plugin designed for visual OSINT investigations directly on Obsidian Canvas. It leverages autonomous AI agents and modern LLMs to build entity graphs, digital footprint maps, target dossiers, and relationship trees.

## Features

- **Obsidian Canvas Integration**: Automatically visualizes investigation findings as interconnected nodes and relationship edges on your active Canvas.
- **Hierarchical Mind-Mapping**: Intelligent left-to-right tree layout with automatic card resizing, collision detection, and neat spacing.
- **Hermes ACP**: Integrates with [Hermes Agent](https://hermes-agent.nousresearch.com) over Agent Client Protocol (ACP), enabling autonomous web searches, deep investigations, Python execution, and verified dossier compilation.
- **Proxy & Anti-Blocking Subsystem**: Built-in methodology and routing support for SOCKS5H / HTTP proxies to bypass geo-restrictions, Cloudflare, and regional firewalls without DNS leaks.
- **Interactive Sidebar & Ribbon**: Dedicated investigation chat view with live streaming, tool call visibility, and quick actions.
- **Smart Updates & Deduplication**: Updates existing nodes as new facts emerge and eliminates outdated or duplicate hypotheses.
- **Privacy-First**: Operates locally within your Obsidian vault. No telemetry or external tracking.

## Proxy Subsystem & Anti-Blocking Routing

A core component of real-world OSINT investigations is reliable access to target registries, international services, social media, and web archives that may enforce geo-blocking or anti-scraping filters (e.g. HTTP 403 Forbidden, Cloudflare challenge, Region Block):

- **SOCKS5H Remote DNS Resolution**: The agent uses SOCKS5H (`socks5h://<host>:<port>`) routing for network tools and scrapers. Remote DNS resolution prevents DNS leakage, ISP-level interception, and poison cache issues.
- **Multi-Tool Routing**: Network commands executed during investigations (`curl`, Python `requests`/`aiohttp`, `playwright`/`browser_exec`) automatically inherit proxy parameters when accessing geo-restricted sources.
- **Local Bridge Isolation**: Internal communication between Obsidian and the agent bridge retains strict `NO_PROXY=127.0.0.1,localhost` protection to guarantee that local IPC / ACP daemon traffic is never routed through external proxies.

To configure your proxy environment, ensure your local or upstream proxy (e.g. SOCKS5 on `127.0.0.1:2080`, `127.0.0.1:9050` (Tor), or HTTP proxy) is active, and set standard environment variables (`ALL_PROXY` / `HTTPS_PROXY`) or configure proxy options within your agent profile.

## Installation

### Manual Installation

1. Download or clone this repository.
2. Copy the following files into your Obsidian vault's plugin directory:
   `<Vault>/.obsidian/plugins/vibeosint/`
   - `manifest.json`
   - `main.js`
   - `styles.css`
3. Reload Obsidian (`Ctrl+R` or restart).
4. Go to **Settings -> Community plugins**, find the installed plugin, and enable it.

## Configuration

Open the plugin settings:

- **Hermes ACP Settings**:
  - Requires Hermes Agent installed and accessible in your environment (`hermes`).
  - Configure the model identifier accepted by your Hermes installation.

## Usage

1. Open an existing `.canvas` file or create a new one in Obsidian.
2. Click the crosshair icon in the ribbon or open the **OSINT Canvas Agent** sidebar.
3. Enter your investigation target (username, phone number, domain, organization, or person).
4. Watch the agent analyze findings and build an investigation graph in real-time.

## License

MIT License. See [LICENSE](LICENSE) for details.
