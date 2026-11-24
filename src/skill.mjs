import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_MAIN_MODEL,
  OPENAI_BASE_URL,
} from './constants.mjs';
import {
  createBackupSession,
  finalizeBackupSession,
  recordFileBeforeWrite,
} from './backup.mjs';
import { c, printHeader, printInfo, printOk, printWarn } from './ui.mjs';

export const BF16_SIDECAR_SKILL_MD = `---
name: bf16-uncensored-sidecar
description: Delegate uncensored, red-team security, creative writing, or 1M-context repo analysis tasks to bf16.ai (Zero Data Retention) without switching your primary coding subscription.
---

# bf16.ai Uncensored 1M-Context Sidecar

Use this skill when the user asks to:
1. Run security / red-team / CTF / vulnerability analysis or mature fiction / dialogue that triggers false-positive safety refusals on default models.
2. Process massive codebases or logs needing a **1,048,576-token (1M)** context window at Flash pricing.
3. Require **Zero Data Retention (ZDR)** inference (no prompts/responses logged or retained).

## Preferred Tools

- If the \`bf16-mcp-server\` MCP server is available, call \`bf16_chat\` or \`bf16_models\`.
- Otherwise, call the OpenAI-compatible API directly using \`$BF16_API_KEY\`:
  - Base URL: \`${OPENAI_BASE_URL}\`
  - Flagship 1M model: \`${DEFAULT_MAIN_MODEL}\`
  - Fast 1M + Vision model: \`${DEFAULT_FAST_MODEL}\`
  - Account balance check: \`GET ${OPENAI_BASE_URL}/me\`

## Quick CLI Commands

- One-session Claude Code on bf16: \`npx bf16 claude\`
- Live balance & diagnostics: \`npx bf16 doctor\`
- Live latency benchmark: \`npx bf16 bench\`
`;

export const BF16_CURSOR_RULE_MDC = `---
description: Route uncensored, red-team security, or 1M-context sidecar requests to bf16.ai (Zero Data Retention).
globs:
alwaysApply: false
---

# bf16.ai Sidecar

When the user explicitly asks to use **bf16.ai** (or needs uncensored / ZDR / 1M-context inference):
- Endpoint: \`${OPENAI_BASE_URL}\` (or Anthropic Messages at \`https://api.bf16.ai\`)
- Models: \`${DEFAULT_MAIN_MODEL}\` (flagship 1M), \`${DEFAULT_FAST_MODEL}\` (fast 1M + vision)
- MCP server: \`npx -y bf16-mcp-server\` (env \`BF16_API_KEY\`)
`;

export function installSidecarSkill({
  client = 'all',
  withMcp = false,
  homeDir = os.homedir(),
  cwd = process.cwd(),
} = {}) {
  const session = createBackupSession('install-skill', homeDir);
  const installed = [];
  const target = client.toLowerCase();

  if (target === 'all' || target === 'claude' || target === 'claude-code') {
    const dest = path.join(homeDir, '.claude', 'skills', 'bf16', 'SKILL.md');
    recordFileBeforeWrite(session, dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, BF16_SIDECAR_SKILL_MD, 'utf8');
    installed.push({ client: 'claude', file: dest });
  }

  if (target === 'all' || target === 'codex') {
    const dest = path.join(homeDir, '.codex', 'skills', 'bf16', 'SKILL.md');
    recordFileBeforeWrite(session, dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, BF16_SIDECAR_SKILL_MD, 'utf8');
    installed.push({ client: 'codex', file: dest });
  }

  if (target === 'cursor') {
    const dest = path.join(cwd, '.cursor', 'rules', 'bf16.mdc');
    recordFileBeforeWrite(session, dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, BF16_CURSOR_RULE_MDC, 'utf8');
    installed.push({ client: 'cursor', file: dest });
  }

  if (withMcp) {
    const mcpPath = path.join(cwd, '.mcp.json');
    recordFileBeforeWrite(session, mcpPath);
    let existing = {};
    if (fs.existsSync(mcpPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8') || '{}');
      } catch {
        existing = {};
      }
    }
    const merged = {
      ...existing,
      mcpServers: {
        ...(existing.mcpServers || {}),
        bf16: {
          command: 'npx',
          args: ['-y', 'bf16-mcp-server'],
          env: {
            BF16_API_KEY: '${BF16_API_KEY}',
          },
        },
      },
    };
    fs.writeFileSync(mcpPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    installed.push({ client: 'mcp', file: mcpPath });
  }

  const manifest = finalizeBackupSession(session);
  return { installed, manifest };
}

export function runInstallSkill({
  client = 'all',
  withMcp = false,
  homeDir = os.homedir(),
  cwd = process.cwd(),
} = {}) {
  printHeader(
    'install-skill',
    'Install bf16 uncensored 1M-context sidecar skill (keeps your primary subscription intact)'
  );
  const { installed, manifest } = installSidecarSkill({
    client,
    withMcp,
    homeDir,
    cwd,
  });

  if (installed.length === 0) {
    printWarn(`Unknown client "${client}". Use --client=claude|codex|cursor|all`);
    process.exitCode = 1;
    return;
  }

  for (const item of installed) {
    printOk(`${c.bold(item.client)}: installed ${c.dim(item.file)}`);
  }
  console.log('');
  if (!withMcp) {
    printInfo(
      `Want native MCP tool calls too? Run ${c.cyan('npx bf16 install-skill --mcp')}`
    );
  }
  if (manifest) {
    printInfo(`Rollback anytime: ${c.cyan('npx bf16 undo')}`);
  }
  console.log('');
}
