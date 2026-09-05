# Gemini Canvas OSINT (Obsidian Plugin)

**Gemini Canvas OSINT** is an Obsidian plugin designed for visual OSINT investigations directly on Obsidian Canvas. It leverages autonomous AI agents and modern LLMs to build entity graphs, digital footprint maps, target dossiers, and relationship trees.

## Features

- **Obsidian Canvas Integration**: Automatically visualizes investigation findings as interconnected nodes and relationship edges on your active Canvas.
- **Hierarchical Mind-Mapping**: Intelligent left-to-right tree layout with automatic card resizing, collision detection, and neat spacing.
- **Dual Engine Architecture**:
  - **Hermes ACP Mode**: Integrates with [Hermes Agent](https://hermes-agent.nousresearch.com) over Agent Client Protocol (ACP), enabling autonomous web searches, deep investigations, Python execution, and verified dossier compilation.
  - **Direct API Mode**: Direct REST integration supporting OpenAI-compatible endpoints, Google Gemini, OpenRouter, and custom LLM providers.
- **Interactive Sidebar & Ribbon**: Dedicated investigation chat view with live streaming, tool call visibility, and quick actions.
- **Smart Updates & Deduplication**: Updates existing nodes as new facts emerge and eliminates outdated or duplicate hypotheses.
- **Privacy-First**: Operates locally within your Obsidian vault. No telemetry or external tracking.

## Installation

### Manual Installation

1. Download or clone this repository.
2. Copy the following files into your Obsidian vault's plugin directory:
   `<Vault>/.obsidian/plugins/gemini-canvas-osint/`
   - `manifest.json`
   - `main.js`
   - `styles.css`
3. Reload Obsidian (`Ctrl+R` or restart).
4. Go to **Settings -> Community plugins**, find **Gemini Canvas OSINT**, and enable it.

## Configuration

Open **Settings -> Gemini Canvas OSINT**:

- **Engine Mode**: Choose between `Hermes ACP` (autonomous system agent) or `Direct API` (standard LLM chat).
- **Hermes ACP Settings**:
  - Requires Hermes Agent installed and accessible in your environment (`hermes`).
  - Configure the model identifier (e.g. `agy/gemini-3.8-flash-high`, `gemini-2.0-flash`).
- **Direct API Settings**:
  - Set your `API Base URL` (e.g., `https://api.openai.com/v1` or OpenRouter).
  - Provide your `API Key`.
  - Choose your preferred target model.

## Usage

1. Open an existing `.canvas` file or create a new one in Obsidian.
2. Click the crosshair icon in the ribbon or open the **OSINT Canvas Agent** sidebar.
3. Enter your investigation target (username, phone number, domain, organization, or person).
4. Watch the agent analyze findings and build an investigation graph in real-time.

## License

MIT License. See [LICENSE](LICENSE) for details.
