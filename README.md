# `bf16ai` — Official CLI for [bf16.ai](https://bf16.ai)

Run **Claude Code, Codex, OpenCode, Goose, Pi, and Qwen Code** on uncensored **1M-context** frontier open-weight models with a single command.

- **Zero-touch launchers**: `npx bf16ai claude` injects clean session env vars without modifying `~/.claude/settings.json` or breaking your existing subscriptions.
- **Lossless rollback**: `npx bf16ai setup` backs up every file it touches to `~/.bf16/backups/` — run `npx bf16ai undo` anytime.
- **Zero Data Retention (ZDR)**: prompts and responses are never logged or retained.
- **Zero dependencies**: pure Node.js ESM (`>=18.18`), instant cold start.

## Quickstart

```bash
# 1. Run Claude Code on bf16.ai (auto-authenticates in your browser on first run)
npx bf16ai claude

# Or use the ultra-fast Flash tier (1M context + vision, $0.26 / 1M input)
npx bf16ai claude --fast

# Pass arguments directly to Claude Code
npx bf16ai claude -- -p "Audit this repository for auth bypass risks"
```

Prefer permanent installation?

```bash
npm install -g bf16ai
bf16 claude
```

## Commands

### Zero-Touch Agent Launchers

| Command | Protocol | What it does |
| --- | --- | --- |
| `npx bf16ai claude` | Anthropic `/v1/messages` | Unsets conflicting `ANTHROPIC_API_KEY`, pins Haiku & subagents to Flash `[1m]`, sets `ENABLE_TOOL_SEARCH=false`, runs flagship `zai-org/glm-5.3-uncensored[1m]`. |
| `npx bf16ai codex` | OpenAI `/v1/responses` | Writes isolated `~/.codex/bf16.config.toml` and runs `codex --profile bf16`. |
| `npx bf16ai opencode` | OpenAI `/v1/chat/completions` | Writes isolated `~/.config/opencode/bf16.json` and launches with `OPENCODE_CONFIG`. |
| `npx bf16ai goose` | OpenAI `/v1/chat/completions` | Injects `OPENAI_HOST=https://api.bf16.ai` (no `/v1`) and launches `goose session`. |
| `npx bf16ai pi` | Anthropic `/v1/messages` | Registers `bf16` provider and launches `pi --provider bf16`. |
| `npx bf16ai qwen` | OpenAI `/v1/chat/completions` | Injects `OPENAI_BASE_URL=https://api.bf16.ai/v1` and launches `qwen`. |

Model shorthand flags supported on every launcher: `--fast` (`deepseek-v4.1-flash-uncensored`), `--turbo` (`deepseek-v4.1-flash-uncensored-fast`), `--flash` (`glm-5.3-flash-uncensored`), `--pro` (`kimi-k3.1-pro-uncensored`), or `--model <id>`.

### Auto-Setup, Rollback, Statusline & Sidecar Skill

```bash
# Auto-detect installed coding agents and configure them safely with backups
npx bf16ai setup

# Restore every file touched by bf16 setup / statusline / install-skill
npx bf16ai undo

# Install a live bf16 balance + 1M context status bar into Claude Code
npx bf16ai statusline --install

# Keep Claude Max as your main agent and add bf16 as an on-demand uncensored sidecar Skill (+ MCP)
npx bf16ai install-skill --mcp
```

### Account, Diagnostics, Benchmark & Local Smart Proxy

```bash
# Browser OAuth login (or pass an existing key directly)
npx bf16ai login
npx bf16ai login --key sk-bf16-v1-...

# Check live USD balance, tier, concurrency & RPM via GET /v1/me
npx bf16ai whoami

# Diagnose API connectivity, key validity, trailing /v1 mistakes & conflicting env vars
npx bf16ai doctor

# Measure real TTFT & tokens/sec from your own network
npx bf16ai bench
npx bf16ai bench --compare   # Locally compare against your OPENAI_API_KEY / OPENROUTER_API_KEY

# Live catalog & cost comparison vs Claude Sonnet 4.6 / Opus 4.6 / GPT-5.4
npx bf16ai models
npx bf16ai cost main --in=500000 --out=25000 --cache=0.8

# Zero-logging local routing proxy (http://127.0.0.1:4160/v1) with bf16/smart alias
npx bf16ai proxy --port=4160

# Share your referral invite command (+20% first-top-up bonus for friends)
npx bf16ai referral
```

## Scaffold a New App

```bash
npm create bf16 my-app
```

## Related Packages & Links

- Website & Console: [https://bf16.ai](https://bf16.ai)
- Illustrated Setup Guides (34 clients): [https://bf16.ai/docs/clients](https://bf16.ai/docs/clients)
- Vercel AI SDK Provider: [`bf16-ai-sdk-provider`](https://www.npmjs.com/package/bf16-ai-sdk-provider)
- Official MCP Server: [`bf16-mcp-server`](https://www.npmjs.com/package/bf16-mcp-server)
- GitHub: [https://github.com/BF16-AI/bf16](https://github.com/BF16-AI/bf16)

## License

MIT © BF16 Team
