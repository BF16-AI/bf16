import os from 'node:os';
import {
  API_ORIGIN,
  CLI_VERSION,
  CREDITS_URL,
  OPENAI_BASE_URL,
} from './constants.mjs';
import { fetchMe, fetchModels } from './api.mjs';
import { resolveApiKey } from './credentials.mjs';
import { detectInstalledClients } from './clients.mjs';
import {
  c,
  formatUsd,
  maskApiKey,
  printErr,
  printHeader,
  printInfo,
  printOk,
  printWarn,
} from './ui.mjs';

export function diagnoseEnvIssues(env = process.env) {
  const warnings = [];
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
    warnings.push({
      code: 'dual_anthropic_auth',
      message:
        'Both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are set. Claude Code prefers ANTHROPIC_API_KEY and may hit Anthropic directly.',
      fix: 'Use `npx bf16 claude` (which unsets ANTHROPIC_API_KEY automatically) or run `unset ANTHROPIC_API_KEY`.',
    });
  }
  if (env.ANTHROPIC_BASE_URL && /\/v1\/?$/.test(env.ANTHROPIC_BASE_URL.trim())) {
    warnings.push({
      code: 'anthropic_trailing_v1',
      message: `ANTHROPIC_BASE_URL ends with /v1 (${env.ANTHROPIC_BASE_URL}). Anthropic SDKs append /v1/messages automatically, causing /v1/v1/messages 404s.`,
      fix: `Set ANTHROPIC_BASE_URL=${API_ORIGIN} (without /v1).`,
    });
  }
  if (env.OPENAI_HOST && /\/v1\/?$/.test(env.OPENAI_HOST.trim())) {
    warnings.push({
      code: 'goose_trailing_v1',
      message: `OPENAI_HOST ends with /v1 (${env.OPENAI_HOST}). Goose appends /v1/chat/completions automatically.`,
      fix: `Set OPENAI_HOST=${API_ORIGIN} (without /v1).`,
    });
  }
  return warnings;
}

export async function runDoctor({ flagKey = null, json = false } = {}) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const resolved = resolveApiKey({ flagKey });
  const envWarnings = diagnoseEnvIssues(process.env);
  const installed = detectInstalledClients(os.homedir());

  const [modelsRes, meRes] = await Promise.all([
    fetchModels(resolved.key, { timeoutMs: 8000 }),
    resolved.key ? fetchMe(resolved.key, { timeoutMs: 8000 }) : Promise.resolve(null),
  ]);

  const report = {
    cliVersion: CLI_VERSION,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    apiOrigin: API_ORIGIN,
    gatewayReachable: modelsRes.ok,
    modelsLatencyMs: modelsRes.latencyMs,
    activeModelsCount: modelsRes.ok ? modelsRes.models.length : 0,
    auth: {
      configured: Boolean(resolved.key),
      source: resolved.source,
      maskedKey: maskApiKey(resolved.key),
      valid: Boolean(meRes?.ok),
      status: meRes?.status ?? null,
      latencyMs: meRes?.latencyMs ?? null,
      error: meRes && !meRes.ok ? meRes.error : null,
      balanceUsd: meRes?.data?.balance?.available_usd ?? null,
      reservedUsd: meRes?.data?.balance?.reserved_usd ?? null,
      tier: meRes?.data?.tier?.name ?? null,
      concurrency: meRes?.data?.concurrency ?? null,
    },
    envWarnings,
    detectedClients: installed.filter((x) => x.detected).map((x) => x.id),
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    if (!report.gatewayReachable || (resolved.key && !report.auth.valid)) {
      process.exitCode = 1;
    }
    return;
  }

  printHeader('doctor', `bf16-cli v${CLI_VERSION} · Node ${process.versions.node} · ${process.platform}-${process.arch}`);

  if (nodeMajor >= 18) {
    printOk(`Runtime: Node ${process.versions.node}`);
  } else {
    printWarn(`Runtime: Node ${process.versions.node} (Node >= 18.18 recommended)`);
  }

  if (modelsRes.ok) {
    printOk(
      `Gateway: ${OPENAI_BASE_URL}/models reachable (${modelsRes.latencyMs}ms · ${modelsRes.models.length} active models)`
    );
  } else {
    printErr(
      `Gateway: could not reach ${OPENAI_BASE_URL}/models (${modelsRes.error || `HTTP ${modelsRes.status}`})`
    );
    process.exitCode = 1;
  }

  if (!resolved.key) {
    printWarn('Auth: No API key configured yet.');
    printInfo(`Run ${c.cyan('npx bf16 login')} to sign in and claim $0.20 starter credit.`);
  } else if (meRes?.ok) {
    const avail = Number(meRes.data?.balance?.available_usd ?? 0);
    const tier = meRes.data?.tier?.name || `Tier ${meRes.data?.tier?.id ?? 0}`;
    const conc = meRes.data?.concurrency
      ? `${meRes.data.concurrency.in_use}/${meRes.data.concurrency.limit}`
      : '-';
    printOk(
      `Auth: ${maskApiKey(resolved.key)} (${resolved.source}) valid (${meRes.latencyMs}ms)`
    );
    printOk(
      `Account: ${c.bold(formatUsd(avail, 4))} available · ${tier} · Concurrency ${conc}`
    );
    if (avail < 0.1) {
      printWarn(`Low balance (${formatUsd(avail, 4)}). Top up at ${c.cyan(CREDITS_URL)}`);
    }
  } else {
    printErr(
      `Auth: ${maskApiKey(resolved.key)} (${resolved.source}) rejected — ${meRes?.error || 'unknown error'}`
    );
    printInfo(`Re-authenticate with ${c.cyan('npx bf16 login')}`);
    process.exitCode = 1;
  }

  if (envWarnings.length === 0) {
    printOk('Environment: No conflicting ANTHROPIC_API_KEY / trailing /v1 issues found');
  } else {
    for (const w of envWarnings) {
      printWarn(`${w.message}`);
      console.log(`      Fix: ${c.cyan(w.fix)}`);
    }
  }

  const foundClients = installed.filter((x) => x.detected);
  if (foundClients.length > 0) {
    printOk(
      `Installed agents (${foundClients.length}): ${foundClients.map((x) => x.name).join(', ')}`
    );
  } else {
    printInfo('Installed agents: none auto-detected on PATH');
  }
  console.log('');
}
