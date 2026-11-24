#!/usr/bin/env node

import { CLI_VERSION, DOCS_CLIENTS_URL } from '../src/constants.mjs';
import { runLogin, runLogout, runReferral, runWhoami } from '../src/auth.mjs';
import { launchClient, runSetup } from '../src/clients.mjs';
import { listBackupSessions, restoreBackupSession } from '../src/backup.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { runBench } from '../src/bench.mjs';
import { runCost, runModels } from '../src/models.mjs';
import { runStatusline } from '../src/statusline.mjs';
import { runInstallSkill } from '../src/skill.mjs';
import { runProxy } from '../src/proxy.mjs';
import { c, printErr, printHeader, printInfo, printOk, printWarn } from '../src/ui.mjs';

const LAUNCHER_COMMANDS = new Set([
  'claude',
  'claude-code',
  'codex',
  'opencode',
  'goose',
  'pi',
  'qwen',
  'qwen-code',
]);

export function parseArgs(argv) {
  const dashIdx = argv.indexOf('--');
  const mainArgv = dashIdx === -1 ? argv : argv.slice(0, dashIdx);
  const passthrough = dashIdx === -1 ? [] : argv.slice(dashIdx + 1);

  const flags = {};
  const positional = [];
  const unknownFlags = [];

  const VALUE_FLAGS = new Set([
    'key',
    'model',
    'ref',
    'port',
    'host',
    'models',
    'prompt',
    'max-tokens',
    'in',
    'out',
    'cache',
    'client',
    'fast-model',
    'pro-model',
    'session',
    'code',
  ]);

  const BOOL_FLAGS = new Set([
    'help',
    'version',
    'json',
    'fast',
    'turbo',
    'pro',
    'flash',
    'compare',
    'install',
    'mcp',
    'dry-run',
    'no-browser',
    'list',
  ]);

  for (let i = 0; i < mainArgv.length; i++) {
    const token = mainArgv[i];
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '-v' || token === '-V') {
      flags.version = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inlineVal = eq === -1 ? null : token.slice(eq + 1);

      if (VALUE_FLAGS.has(rawName)) {
        flags[rawName] = inlineVal !== null ? inlineVal : mainArgv[++i];
      } else if (BOOL_FLAGS.has(rawName)) {
        flags[rawName] = inlineVal === null ? true : inlineVal !== 'false';
      } else {
        unknownFlags.push(token);
      }
      continue;
    }
    positional.push(token);
  }

  return {
    command: positional[0] || null,
    args: positional.slice(1),
    flags,
    passthrough: [...unknownFlags, ...passthrough],
  };
}

function printHelp() {
  console.log(`
${c.bold(c.cyan('bf16'))} ${c.dim(`v${CLI_VERSION}`)} — Uncensored 1M-context LLM API CLI (${c.cyan('https://bf16.ai')})
Zero Data Retention · OpenAI + Anthropic + Responses APIs · $0.20 starter credit

${c.bold('ZERO-TOUCH LAUNCHERS')} ${c.dim('(never modifies your existing Claude/OpenCode configs)')}
  ${c.cyan('npx bf16 claude')} [--fast|--pro|--model <id>]   Run Claude Code on bf16.ai (1M ctx)
  ${c.cyan('npx bf16 codex')}  [--model <id>]                Run OpenAI Codex CLI (--profile bf16)
  ${c.cyan('npx bf16 opencode')} [--model <id>]              Run OpenCode with isolated bf16.json
  ${c.cyan('npx bf16 goose')}  [--model <id>]                Run Goose session on bf16.ai
  ${c.cyan('npx bf16 pi')}     [--model <id>]                Run Pi Coding Agent on bf16.ai
  ${c.cyan('npx bf16 qwen')}   [--model <id>]                Run Qwen Code on bf16.ai

${c.bold('SETUP & SAFE ROLLBACK')}
  ${c.cyan('npx bf16 setup')} [client|all] [--dry-run]       Auto-detect agents & configure with backup
  ${c.cyan('npx bf16 undo')}  [--list]                       Lossless rollback of setup/skill changes
  ${c.cyan('npx bf16 statusline')} [--install]               Claude Code live balance & context status bar
  ${c.cyan('npx bf16 install-skill')} [--client=all] [--mcp] Install uncensored sidecar Skill (+ MCP)

${c.bold('ACCOUNT, DIAGNOSTICS & TOOLS')}
  ${c.cyan('npx bf16 login')} [--key <sk-...>] [--ref=<code>] Browser OAuth or API key login (0600)
  ${c.cyan('npx bf16 whoami')} / ${c.cyan('balance')} [--json]             Check live USD balance, tier & concurrency
  ${c.cyan('npx bf16 doctor')} [--json]                      Diagnose API key, latency & env conflicts
  ${c.cyan('npx bf16 bench')}  [--models=...] [--compare]    Measure real TTFT & tok/s from your network
  ${c.cyan('npx bf16 models')} [--json]                      List active models, context & /1M pricing
  ${c.cyan('npx bf16 cost')}   [model] [--in=500000] [--out=25000] [--cache=0.8]
  ${c.cyan('npx bf16 proxy')}  [--port=4160]                 Zero-logging local proxy with bf16/smart routing
  ${c.cyan('npx bf16 referral')}                             Print shareable \`npx bf16 claude --ref=...\`
  ${c.cyan('npx bf16 logout')}                               Remove local credentials (~/.bf16/credentials.json)

${c.bold('EXAMPLES')}
  ${c.dim('$')} npx bf16 claude
  ${c.dim('$')} npx bf16 claude --fast -- -p "Audit this repo for auth bugs"
  ${c.dim('$')} npx bf16 setup && npx bf16 doctor
  ${c.dim('$')} npx bf16 bench --models=turbo,main

Full illustrated guides for 34 clients: ${c.cyan(DOCS_CLIENTS_URL)}
`);
}

function resolveShorthandModel(flags) {
  if (flags.model) return flags.model;
  if (flags.turbo) return 'turbo';
  if (flags.fast) return 'fast';
  if (flags.flash) return 'flash';
  if (flags.pro) return 'pro';
  return null;
}

function runUndo({ list = false, sessionId = null } = {}) {
  printHeader('undo', 'Restore files touched by bf16 setup / statusline / install-skill');
  if (list) {
    const sessions = listBackupSessions();
    if (sessions.length === 0) {
      printInfo('No backups found.');
      return;
    }
    for (const s of sessions) {
      printInfo(`${c.bold(s.id)} (${s.entries.length} files · ${s.createdAt})`);
    }
    return;
  }

  const res = restoreBackupSession(sessionId);
  if (!res.ok) {
    printWarn(
      res.reason === 'no_backups'
        ? 'Nothing to undo — no bf16 backups exist.'
        : `Backup session "${sessionId}" not found.`
    );
    return;
  }
  for (const f of res.restored) {
    printOk(`Restored original file: ${c.dim(f)}`);
  }
  for (const f of res.removed) {
    printOk(`Removed newly created file: ${c.dim(f)}`);
  }
  console.log('');
  printInfo(`Rolled back session ${c.bold(res.session.id)}.`);
  console.log('');
}

async function main() {
  const { command, args, flags, passthrough } = parseArgs(process.argv.slice(2));

  if (flags.version || command === 'version') {
    console.log(CLI_VERSION);
    return;
  }

  if (!command || command === 'help' || (flags.help && !LAUNCHER_COMMANDS.has(command))) {
    printHelp();
    return;
  }

  const cmd = command.toLowerCase();

  if (LAUNCHER_COMMANDS.has(cmd)) {
    await launchClient(cmd, {
      flagKey: flags.key,
      model: resolveShorthandModel(flags),
      ref: flags.ref,
      extraArgs: [...args, ...passthrough],
    });
    return;
  }

  switch (cmd) {
    case 'login':
    case 'auth':
    case 'init':
      await runLogin({
        flagKey: flags.key || args[0] || null,
        ref: flags.ref || null,
        noBrowser: Boolean(flags['no-browser']),
        port: flags.port ? Number(flags.port) : 0,
      });
      return;

    case 'logout':
      runLogout();
      return;

    case 'whoami':
    case 'balance':
    case 'me':
      await runWhoami({
        flagKey: flags.key,
        json: Boolean(flags.json),
      });
      return;

    case 'setup':
      await runSetup({
        targetClient: args[0] || null,
        flagKey: flags.key,
        ref: flags.ref,
        dryRun: Boolean(flags['dry-run']),
      });
      return;

    case 'undo':
    case 'rollback':
      runUndo({
        list: Boolean(flags.list),
        sessionId: flags.session || args[0] || null,
      });
      return;

    case 'doctor':
    case 'check':
      await runDoctor({
        flagKey: flags.key,
        json: Boolean(flags.json),
      });
      return;

    case 'bench':
    case 'benchmark':
      await runBench({
        flagKey: flags.key,
        ref: flags.ref,
        modelsArg: flags.models || args[0] || null,
        compare: Boolean(flags.compare),
        prompt: flags.prompt || undefined,
        maxTokens: flags['max-tokens'] ? Number(flags['max-tokens']) : 180,
        json: Boolean(flags.json),
      });
      return;

    case 'models':
    case 'ls':
      await runModels({
        flagKey: flags.key,
        json: Boolean(flags.json),
      });
      return;

    case 'cost':
    case 'price':
    case 'pricing':
      await runCost({
        modelArg: args[0] || flags.model || 'main',
        inputTokens: flags.in ? Number(flags.in) : 500_000,
        outputTokens: flags.out ? Number(flags.out) : 25_000,
        cacheRatio: flags.cache !== undefined ? Number(flags.cache) : 0.8,
        json: Boolean(flags.json),
      });
      return;

    case 'statusline':
      await runStatusline({
        install: Boolean(flags.install),
        flagKey: flags.key,
      });
      return;

    case 'install-skill':
    case 'skill':
      runInstallSkill({
        client: flags.client || args[0] || 'all',
        withMcp: Boolean(flags.mcp),
      });
      return;

    case 'proxy':
      await runProxy({
        flagKey: flags.key,
        ref: flags.ref,
        port: flags.port ? Number(flags.port) : 4160,
        host: flags.host || '127.0.0.1',
        fastModel: flags['fast-model'] || undefined,
        proModel: flags['pro-model'] || undefined,
      });
      return;

    case 'referral':
    case 'ref':
      runReferral({ code: flags.code || args[0] || null });
      return;

    default:
      printErr(`Unknown command "${command}".`);
      printInfo(`Run ${c.cyan('npx bf16 --help')} to see all available commands.`);
      process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('/bf16.mjs') ||
    process.argv[1].endsWith('\\bf16.mjs') ||
    process.argv[1].endsWith('/bf16') ||
    process.argv[1].endsWith('\\bf16'));

if (isDirectRun) {
  main().catch((err) => {
    printErr(err?.message || String(err));
    process.exitCode = 1;
  });
}
