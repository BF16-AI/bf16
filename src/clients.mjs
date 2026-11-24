import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  API_ORIGIN,
  CREDITS_URL,
  DEFAULT_FAST_MODEL,
  DEFAULT_FLASH_VISION_MODEL,
  DEFAULT_MAIN_MODEL,
  DEFAULT_PRO_MODEL,
  DOCS_CLIENTS_URL,
  FALLBACK_MODELS,
  OPENAI_BASE_URL,
  resolveModelId,
} from './constants.mjs';
import { fetchModels } from './api.mjs';
import { ensureApiKey } from './auth.mjs';
import {
  createBackupSession,
  finalizeBackupSession,
  recordFileBeforeWrite,
} from './backup.mjs';
import {
  c,
  printErr,
  printHeader,
  printInfo,
  printOk,
  printWarn,
} from './ui.mjs';

export function commandExists(bin) {
  const checkCmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(checkCmd, [bin], { stdio: 'ignore' });
  return res.status === 0;
}

export function buildCodexProfileToml(model = DEFAULT_FAST_MODEL) {
  return `# Managed by bf16 CLI — undo anytime with: npx bf16 undo
model = "${model}"
model_provider = "bf16"
model_context_window = 1048576
model_auto_compact_token_limit = 900000

[model_providers.bf16]
name = "bf16.ai"
base_url = "${OPENAI_BASE_URL}"
wire_api = "responses"
env_key = "BF16_API_KEY"
`;
}

export function buildOpenCodeConfig(models = FALLBACK_MODELS) {
  const modelsObj = {};
  for (const m of models) {
    modelsObj[m.id] = {
      name: m.name || m.id,
      ...(m.supportsVision ? { attachment: true } : {}),
      reasoning: Boolean(m.supportsReasoning ?? true),
      temperature: true,
      tool_call: Boolean(m.supportsTools ?? true),
      modalities: {
        input: m.supportsVision ? ['text', 'image'] : ['text'],
        output: ['text'],
      },
      limit: {
        context: m.contextWindow || 1048576,
        output: m.maxOutputTokens || 131072,
      },
    };
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      bf16: {
        npm: '@ai-sdk/openai-compatible',
        name: 'bf16.ai',
        options: {
          baseURL: OPENAI_BASE_URL,
          apiKey: '{env:BF16_API_KEY}',
        },
        models: modelsObj,
      },
    },
  };
}

export function buildPiModelsConfig(models = FALLBACK_MODELS) {
  return {
    providers: {
      bf16: {
        baseUrl: API_ORIGIN,
        api: 'anthropic-messages',
        apiKey: '!printenv BF16_API_KEY',
        models: models.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          reasoning: Boolean(m.supportsReasoning ?? true),
          input: m.supportsVision ? ['text', 'image'] : ['text'],
          contextWindow: m.contextWindow || 1048576,
          maxTokens: m.maxOutputTokens || 131072,
        })),
      },
    },
  };
}

export function buildZedProviderSnippet(models = FALLBACK_MODELS) {
  return {
    api_url: OPENAI_BASE_URL,
    available_models: models.slice(0, 6).map((m) => ({
      name: m.id,
      display_name: m.name || m.id,
      max_tokens: m.contextWindow || 1048576,
      max_output_tokens: m.maxOutputTokens || 131072,
      capabilities: {
        tools: Boolean(m.supportsTools ?? true),
        images: Boolean(m.supportsVision),
        thinking: Boolean(m.supportsReasoning ?? true),
      },
    })),
  };
}

/**
 * Computes exact clean child-process environment for zero-touch `bf16 claude`.
 * Mirrors bf16.ai official snippets:
 * - Unsets ANTHROPIC_API_KEY to avoid dual-auth conflicts
 * - Pins Haiku & subagents to flash tier (1M) so fan-out never burns trial credit
 * - Sets ENABLE_TOOL_SEARCH=false and appends `[1m]` suffix to main model
 */
export function buildClaudeLaunchSpec({
  apiKey,
  model = DEFAULT_MAIN_MODEL,
  haikuModel = DEFAULT_FAST_MODEL,
  extraArgs = [],
  baseEnv = process.env,
}) {
  const resolvedMain = resolveModelId(model);
  const resolvedHaiku = resolveModelId(haikuModel);
  const with1m = (id) => (id.endsWith('[1m]') ? id : `${id}[1m]`);

  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
  env.BF16_API_KEY = apiKey;
  env.ANTHROPIC_BASE_URL = API_ORIGIN;
  env.ANTHROPIC_AUTH_TOKEN = apiKey;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = with1m(resolvedHaiku);
  env.CLAUDE_CODE_SUBAGENT_MODEL = with1m(resolvedHaiku);
  env.ENABLE_TOOL_SEARCH = 'false';

  const hasExplicitModelArg = extraArgs.some(
    (a) => a === '--model' || a.startsWith('--model=')
  );
  const args = hasExplicitModelArg
    ? [...extraArgs]
    : ['--model', with1m(resolvedMain), ...extraArgs];

  return { bin: 'claude', args, env, model: resolvedMain };
}

function runInteractiveChild(bin, args, env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: 'inherit',
      env,
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        printErr(`Binary \`${bin}\` was not found in your PATH.`);
        printInfo(`Install \`${bin}\` first, or check guides at ${c.cyan(DOCS_CLIENTS_URL)}`);
        resolve(127);
        return;
      }
      printErr(`Failed to start \`${bin}\`: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export async function launchClient(
  clientName,
  { flagKey = null, model = null, ref = null, extraArgs = [], homeDir = os.homedir() } = {}
) {
  const apiKey = await ensureApiKey({ flagKey, ref });
  const target = clientName.toLowerCase();

  if (target === 'claude' || target === 'claude-code') {
    const spec = buildClaudeLaunchSpec({
      apiKey,
      model: model || DEFAULT_MAIN_MODEL,
      extraArgs,
    });
    console.log(
      c.dim(
        `[bf16] Launching Claude Code → ${spec.model} [1M] · subagents on ${DEFAULT_FAST_MODEL} · ZDR`
      )
    );
    const code = await runInteractiveChild(spec.bin, spec.args, spec.env);
    if (code !== 0) {
      printInfo(`Need more credits or hit 402? Top up at ${c.cyan(CREDITS_URL)}`);
    }
    process.exitCode = code;
    return;
  }

  if (target === 'codex') {
    const resolvedModel = resolveModelId(model || DEFAULT_FAST_MODEL);
    const codexDir = path.join(homeDir, '.codex');
    const profilePath = path.join(codexDir, 'bf16.config.toml');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(profilePath, buildCodexProfileToml(resolvedModel), 'utf8');

    const env = { ...process.env, BF16_API_KEY: apiKey };
    console.log(
      c.dim(`[bf16] Launching Codex (--profile bf16) → ${resolvedModel} [1M] · /v1/responses`)
    );
    const code = await runInteractiveChild(
      'codex',
      ['--profile', 'bf16', ...extraArgs],
      env
    );
    process.exitCode = code;
    return;
  }

  if (target === 'opencode') {
    const resolvedModel = resolveModelId(model || DEFAULT_FAST_MODEL);
    const modelsRes = await fetchModels(apiKey, { timeoutMs: 4000 });
    const ocDir = path.join(homeDir, '.config', 'opencode');
    const ocConfigPath = path.join(ocDir, 'bf16.json');
    fs.mkdirSync(ocDir, { recursive: true });
    fs.writeFileSync(
      ocConfigPath,
      `${JSON.stringify(buildOpenCodeConfig(modelsRes.models), null, 2)}\n`,
      'utf8'
    );
    const env = {
      ...process.env,
      BF16_API_KEY: apiKey,
      OPENCODE_CONFIG: ocConfigPath,
    };
    const hasModelArg = extraArgs.some((a) => a === '--model' || a.startsWith('--model='));
    const args = hasModelArg
      ? extraArgs
      : ['--model', `bf16/${resolvedModel}`, ...extraArgs];
    console.log(
      c.dim(`[bf16] Launching OpenCode (isolated bf16.json) → bf16/${resolvedModel} [1M]`)
    );
    const code = await runInteractiveChild('opencode', args, env);
    process.exitCode = code;
    return;
  }

  if (target === 'goose') {
    const resolvedModel = resolveModelId(model || DEFAULT_FAST_MODEL);
    const env = {
      ...process.env,
      BF16_API_KEY: apiKey,
      GOOSE_PROVIDER: 'openai',
      OPENAI_HOST: API_ORIGIN,
      OPENAI_API_KEY: apiKey,
      GOOSE_MODEL: resolvedModel,
    };
    const args = extraArgs.length > 0 ? extraArgs : ['session'];
    console.log(c.dim(`[bf16] Launching Goose → ${resolvedModel} [1M]`));
    const code = await runInteractiveChild('goose', args, env);
    process.exitCode = code;
    return;
  }

  if (target === 'pi') {
    const resolvedModel = resolveModelId(model || DEFAULT_MAIN_MODEL);
    const modelsRes = await fetchModels(apiKey, { timeoutMs: 4000 });
    const piDir = path.join(homeDir, '.pi', 'agent');
    const piFile = path.join(piDir, 'models.json');
    fs.mkdirSync(piDir, { recursive: true });
    let existing = {};
    if (fs.existsSync(piFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(piFile, 'utf8'));
      } catch {
        existing = {};
      }
    }
    const generated = buildPiModelsConfig(modelsRes.models);
    const merged = {
      ...existing,
      providers: {
        ...(existing.providers || {}),
        bf16: generated.providers.bf16,
      },
    };
    fs.writeFileSync(piFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    const env = { ...process.env, BF16_API_KEY: apiKey };
    const args =
      extraArgs.length > 0
        ? extraArgs
        : ['--provider', 'bf16', '--model', resolvedModel];
    console.log(c.dim(`[bf16] Launching Pi → bf16/${resolvedModel} [1M]`));
    const code = await runInteractiveChild('pi', args, env);
    process.exitCode = code;
    return;
  }

  if (target === 'qwen' || target === 'qwen-code') {
    const resolvedModel = resolveModelId(model || DEFAULT_FAST_MODEL);
    const env = {
      ...process.env,
      BF16_API_KEY: apiKey,
      OPENAI_BASE_URL: OPENAI_BASE_URL,
      OPENAI_API_KEY: apiKey,
      OPENAI_MODEL: resolvedModel,
    };
    console.log(c.dim(`[bf16] Launching Qwen Code → ${resolvedModel} [1M]`));
    const code = await runInteractiveChild('qwen', extraArgs, env);
    process.exitCode = code;
    return;
  }

  printErr(`Unknown launcher "${clientName}".`);
  printInfo('Supported launchers: claude, codex, opencode, goose, pi, qwen');
  process.exitCode = 1;
}

export function detectInstalledClients(homeDir = os.homedir()) {
  const candidates = [
    {
      id: 'claude',
      name: 'Claude Code',
      detected: commandExists('claude') || fs.existsSync(path.join(homeDir, '.claude')),
      mode: 'launcher',
    },
    {
      id: 'codex',
      name: 'OpenAI Codex CLI',
      detected: commandExists('codex') || fs.existsSync(path.join(homeDir, '.codex')),
      mode: 'profile-file',
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      detected:
        commandExists('opencode') ||
        fs.existsSync(path.join(homeDir, '.config', 'opencode')),
      mode: 'isolated-config',
    },
    {
      id: 'pi',
      name: 'Pi Coding Agent',
      detected: commandExists('pi') || fs.existsSync(path.join(homeDir, '.pi')),
      mode: 'merge-json',
    },
    {
      id: 'goose',
      name: 'Goose CLI',
      detected:
        commandExists('goose') ||
        fs.existsSync(path.join(homeDir, '.config', 'goose')),
      mode: 'launcher',
    },
    {
      id: 'zed',
      name: 'Zed IDE',
      detected:
        commandExists('zed') || fs.existsSync(path.join(homeDir, '.config', 'zed')),
      mode: 'merge-json',
    },
    {
      id: 'qwen-code',
      name: 'Qwen Code',
      detected: commandExists('qwen'),
      mode: 'launcher',
    },
    {
      id: 'openclaw',
      name: 'OpenClaw',
      detected: commandExists('openclaw') || fs.existsSync(path.join(homeDir, '.openclaw')),
      mode: 'guide',
    },
    {
      id: 'hermes',
      name: 'Hermes Agent',
      detected: commandExists('hermes') || fs.existsSync(path.join(homeDir, '.hermes')),
      mode: 'guide',
    },
  ];
  return candidates;
}

function readJsonOrEmpty(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * Safely writes isolated or merged client configs with automatic backup.
 * Never mutates the user's primary Claude/OpenCode defaults unless explicitly requested;
 * every touched file is backed up for `npx bf16 undo`.
 */
export function applySetupForClient({
  clientId,
  session,
  models = FALLBACK_MODELS,
  homeDir = os.homedir(),
}) {
  const id = clientId.toLowerCase();

  if (id === 'codex') {
    const target = path.join(homeDir, '.codex', 'bf16.config.toml');
    recordFileBeforeWrite(session, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildCodexProfileToml(DEFAULT_FAST_MODEL), 'utf8');
    return {
      clientId: 'codex',
      file: target,
      runHint: 'codex --profile bf16  (or: npx bf16 codex)',
    };
  }

  if (id === 'opencode') {
    const target = path.join(homeDir, '.config', 'opencode', 'bf16.json');
    recordFileBeforeWrite(session, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify(buildOpenCodeConfig(models), null, 2)}\n`,
      'utf8'
    );
    return {
      clientId: 'opencode',
      file: target,
      runHint: 'npx bf16 opencode',
    };
  }

  if (id === 'pi') {
    const target = path.join(homeDir, '.pi', 'agent', 'models.json');
    recordFileBeforeWrite(session, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let existing = {};
    try {
      existing = readJsonOrEmpty(target);
    } catch {
      existing = {};
    }
    const generated = buildPiModelsConfig(models);
    const merged = {
      ...existing,
      providers: {
        ...(existing.providers || {}),
        bf16: generated.providers.bf16,
      },
    };
    fs.writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return {
      clientId: 'pi',
      file: target,
      runHint: `pi --provider bf16 --model ${DEFAULT_MAIN_MODEL}`,
    };
  }

  if (id === 'zed') {
    const target = path.join(homeDir, '.config', 'zed', 'settings.json');
    recordFileBeforeWrite(session, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let existing = {};
    try {
      existing = readJsonOrEmpty(target);
    } catch {
      return {
        clientId: 'zed',
        file: target,
        skipped: true,
        reason: 'settings.json has comments/JSONC — configure bf16 via Zed UI or https://bf16.ai/docs/clients/zed',
      };
    }
    const merged = {
      ...existing,
      language_models: {
        ...(existing.language_models || {}),
        openai_compatible: {
          ...(existing.language_models?.openai_compatible || {}),
          bf16: buildZedProviderSnippet(models),
        },
      },
    };
    fs.writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return {
      clientId: 'zed',
      file: target,
      runHint: 'Open Zed → Assistant Settings → select bf16.ai',
    };
  }

  if (id === 'claude' || id === 'claude-code') {
    return {
      clientId: 'claude',
      file: null,
      runHint: 'npx bf16 claude  (zero-touch — never overwrites ~/.claude/settings.json)',
    };
  }

  if (id === 'goose') {
    return {
      clientId: 'goose',
      file: null,
      runHint: 'npx bf16 goose',
    };
  }

  if (id === 'qwen' || id === 'qwen-code') {
    return {
      clientId: 'qwen-code',
      file: null,
      runHint: 'npx bf16 qwen',
    };
  }

  if (id === 'openclaw') {
    return {
      clientId: 'openclaw',
      file: null,
      runHint: 'clawhub install bf16-ai  (see https://bf16.ai/docs/clients/openclaw)',
    };
  }

  if (id === 'hermes') {
    return {
      clientId: 'hermes',
      file: null,
      runHint: `OPENAI_BASE_URL=${OPENAI_BASE_URL} OPENAI_API_KEY="$BF16_API_KEY" hermes`,
    };
  }

  return {
    clientId: id,
    file: null,
    skipped: true,
    reason: `See full illustrated guide for 34 clients at ${DOCS_CLIENTS_URL}`,
  };
}

export async function runSetup({
  targetClient = null,
  flagKey = null,
  ref = null,
  dryRun = false,
  homeDir = os.homedir(),
} = {}) {
  printHeader('setup', 'Auto-detect coding agents and configure bf16.ai safely with backups');

  const apiKey = dryRun ? flagKey || process.env.BF16_API_KEY || null : await ensureApiKey({ flagKey, ref });
  const modelsRes = await fetchModels(apiKey, { timeoutMs: 5000 });
  const detected = detectInstalledClients(homeDir);

  let targets = [];
  if (targetClient && targetClient !== 'all') {
    targets = [targetClient.toLowerCase()];
  } else {
    targets = detected.filter((d) => d.detected).map((d) => d.id);
    if (targets.length === 0) {
      targets = ['claude', 'codex', 'opencode'];
    }
  }

  printInfo(`Detected/selected tools: ${c.bold(targets.join(', '))}`);
  if (dryRun) {
    printWarn('Dry run mode — no files will be written.');
    for (const id of targets) {
      printInfo(`Would configure: ${id}`);
    }
    return;
  }

  const session = createBackupSession('setup', homeDir);
  const results = [];
  for (const id of targets) {
    const res = applySetupForClient({
      clientId: id,
      session,
      models: modelsRes.models,
      homeDir,
    });
    results.push(res);
  }
  const manifest = finalizeBackupSession(session);

  console.log('');
  for (const r of results) {
    if (r.skipped) {
      printWarn(`${c.bold(r.clientId)}: ${r.reason}`);
    } else if (r.file) {
      printOk(`${c.bold(r.clientId)}: wrote ${c.dim(r.file)}`);
      console.log(`      Run: ${c.cyan(r.runHint)}`);
    } else {
      printOk(`${c.bold(r.clientId)}: ready`);
      console.log(`      Run: ${c.cyan(r.runHint)}`);
    }
  }

  console.log('');
  if (manifest) {
    printInfo(
      `Backup saved (${manifest.entries.length} file${manifest.entries.length === 1 ? '' : 's'}). ` +
        `Rollback anytime: ${c.cyan('npx bf16 undo')}`
    );
  }
  printInfo(
    `Optional: run ${c.cyan('npx bf16 statusline --install')} or ${c.cyan('npx bf16 install-skill')} for Claude Code.`
  );
}

export {
  DEFAULT_FAST_MODEL,
  DEFAULT_FLASH_VISION_MODEL,
  DEFAULT_MAIN_MODEL,
  DEFAULT_PRO_MODEL,
};
