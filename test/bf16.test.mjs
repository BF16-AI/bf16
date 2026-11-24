import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseArgs } from '../bin/bf16.mjs';
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_MAIN_MODEL,
  DEFAULT_PRO_MODEL,
  resolveModelId,
} from '../src/constants.mjs';
import {
  clearCredentials,
  loadCredentials,
  resolveApiKey,
  saveCredentials,
} from '../src/credentials.mjs';
import {
  createBackupSession,
  finalizeBackupSession,
  listBackupSessions,
  recordFileBeforeWrite,
  restoreBackupSession,
} from '../src/backup.mjs';
import {
  applySetupForClient,
  buildClaudeLaunchSpec,
  buildCodexProfileToml,
  buildOpenCodeConfig,
} from '../src/clients.mjs';
import { diagnoseEnvIssues } from '../src/doctor.mjs';
import { calculateCost } from '../src/models.mjs';
import {
  buildCliAuthUrl,
  isAllowedOrigin,
  startLoopbackAuthServer,
} from '../src/auth.mjs';
import {
  formatStatuslineText,
  installClaudeStatusline,
} from '../src/statusline.mjs';
import { installSidecarSkill } from '../src/skill.mjs';
import { selectSmartModel } from '../src/proxy.mjs';

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bf16-test-'));
}

test('parseArgs parses commands, flags, and passthrough args after --', () => {
  const res = parseArgs([
    'claude',
    '--fast',
    '--ref=FRIEND42',
    '--',
    '-p',
    'audit auth',
  ]);
  assert.equal(res.command, 'claude');
  assert.equal(res.flags.fast, true);
  assert.equal(res.flags.ref, 'FRIEND42');
  assert.deepEqual(res.passthrough, ['-p', 'audit auth']);
});

test('resolveModelId expands aliases cleanly', () => {
  assert.equal(resolveModelId('main'), DEFAULT_MAIN_MODEL);
  assert.equal(resolveModelId('fast'), DEFAULT_FAST_MODEL);
  assert.equal(resolveModelId('pro'), DEFAULT_PRO_MODEL);
  assert.equal(resolveModelId('custom/model'), 'custom/model');
});

test('credentials save/load/resolve/clear respects precedence and 0600 permissions', () => {
  const home = makeTmpHome();
  try {
    const { filePath } = saveCredentials(
      { apiKey: 'sk-bf16-v1-test123456', referralCode: 'ABC123' },
      home
    );
    const stat = fs.statSync(filePath);
    if (process.platform !== 'win32') {
      assert.equal(stat.mode & 0o777, 0o600);
    }
    const loaded = loadCredentials(home);
    assert.equal(loaded.apiKey, 'sk-bf16-v1-test123456');
    assert.equal(loaded.referralCode, 'ABC123');

    assert.equal(
      resolveApiKey({ flagKey: 'sk-flag', env: { BF16_API_KEY: 'sk-env' }, homeDir: home })
        .source,
      'flag'
    );
    assert.equal(
      resolveApiKey({ env: { BF16_API_KEY: 'sk-env' }, homeDir: home }).source,
      'env'
    );
    assert.equal(
      resolveApiKey({ env: {}, homeDir: home }).source,
      'credentials'
    );

    assert.equal(clearCredentials(home), true);
    assert.equal(loadCredentials(home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('buildClaudeLaunchSpec strips ANTHROPIC_API_KEY and sets 1M + subagent pins', () => {
  const spec = buildClaudeLaunchSpec({
    apiKey: 'sk-bf16-v1-demo',
    model: 'main',
    baseEnv: {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-old-conflict',
    },
  });
  assert.equal(spec.bin, 'claude');
  assert.equal('ANTHROPIC_API_KEY' in spec.env, false);
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'https://api.bf16.ai');
  assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, 'sk-bf16-v1-demo');
  assert.equal(spec.env.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(
    spec.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    `${DEFAULT_FAST_MODEL}[1m]`
  );
  assert.equal(
    spec.env.CLAUDE_CODE_SUBAGENT_MODEL,
    `${DEFAULT_FAST_MODEL}[1m]`
  );
  assert.deepEqual(spec.args, ['--model', `${DEFAULT_MAIN_MODEL}[1m]`]);
});

test('setup + backup + undo restores existing files and deletes created files cleanly', () => {
  const home = makeTmpHome();
  try {
    // Pre-existing Pi models.json should be preserved on undo
    const piPath = path.join(home, '.pi', 'agent', 'models.json');
    fs.mkdirSync(path.dirname(piPath), { recursive: true });
    const originalPi = JSON.stringify({ providers: { custom: { baseUrl: 'https://example.com' } } });
    fs.writeFileSync(piPath, originalPi, 'utf8');

    const session = createBackupSession('setup', home);
    applySetupForClient({ clientId: 'codex', session, homeDir: home });
    applySetupForClient({ clientId: 'opencode', session, homeDir: home });
    applySetupForClient({ clientId: 'pi', session, homeDir: home });
    const manifest = finalizeBackupSession(session);
    assert.equal(manifest.entries.length, 3);

    const codexFile = path.join(home, '.codex', 'bf16.config.toml');
    const ocFile = path.join(home, '.config', 'opencode', 'bf16.json');
    assert.equal(fs.existsSync(codexFile), true);
    assert.equal(fs.existsSync(ocFile), true);

    const updatedPi = JSON.parse(fs.readFileSync(piPath, 'utf8'));
    assert.ok(updatedPi.providers.bf16);
    assert.ok(updatedPi.providers.custom);

    assert.equal(listBackupSessions(home).length, 1);

    const undone = restoreBackupSession(null, home);
    assert.equal(undone.ok, true);
    assert.equal(fs.existsSync(codexFile), false);
    assert.equal(fs.existsSync(ocFile), false);
    assert.equal(fs.readFileSync(piPath, 'utf8'), originalPi);
    assert.equal(listBackupSessions(home).length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('buildCodexProfileToml and buildOpenCodeConfig emit valid config structures', () => {
  const toml = buildCodexProfileToml();
  assert.match(toml, /wire_api = "responses"/);
  assert.match(toml, /model_context_window = 1048576/);

  const oc = buildOpenCodeConfig();
  assert.equal(oc.provider.bf16.options.baseURL, 'https://api.bf16.ai/v1');
  assert.ok(oc.provider.bf16.models[DEFAULT_MAIN_MODEL]);
});

test('diagnoseEnvIssues flags dual Anthropic auth and trailing /v1 mistakes', () => {
  const issues = diagnoseEnvIssues({
    ANTHROPIC_API_KEY: 'sk-ant',
    ANTHROPIC_AUTH_TOKEN: 'sk-bf16',
    ANTHROPIC_BASE_URL: 'https://api.bf16.ai/v1',
    OPENAI_HOST: 'https://api.bf16.ai/v1/',
  });
  const codes = issues.map((i) => i.code);
  assert.deepEqual(codes, [
    'dual_anthropic_auth',
    'anthropic_trailing_v1',
    'goose_trailing_v1',
  ]);
});

test('calculateCost computes cached + fresh + output USD accurately', () => {
  const res = calculateCost({
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheHitRatio: 0.8,
    inputPerMillion: 1.0,
    cachedInputPerMillion: 0.2,
    outputPerMillion: 4.0,
  });
  // Fresh: 0.2M * $1 = $0.20; Cached: 0.8M * $0.20 = $0.16; Output: 0.1M * $4 = $0.40 => $0.76
  assert.equal(Number(res.totalUsd.toFixed(4)), 0.76);
});

test('loopback OAuth server validates state, CORS, and receives JSON POST key', async () => {
  const state = 'abcdef0123456789abcdef0123456789';
  const srv = await startLoopbackAuthServer({ expectedState: state, timeoutMs: 5000 });
  try {
    const authUrl = buildCliAuthUrl({
      callbackUrl: srv.callbackUrl,
      state,
      device: 'macOS',
      ref: 'FRIEND99',
    });
    assert.match(authUrl, /https:\/\/bf16\.ai\/cli-auth\?/);
    assert.match(authUrl, /ref=FRIEND99/);
    assert.equal(isAllowedOrigin('https://bf16.ai'), true);
    assert.equal(isAllowedOrigin('https://evil.example.com'), false);

    // Wrong state must be rejected with 400
    const badRes = await fetch(srv.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://bf16.ai',
      },
      body: JSON.stringify({ state: 'wrong', key: 'sk-bf16-v1-abc' }),
    });
    assert.equal(badRes.status, 400);
    assert.equal(badRes.headers.get('access-control-allow-origin'), 'https://bf16.ai');

    // Valid state resolves payload cleanly
    const goodRes = await fetch(srv.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://bf16.ai',
      },
      body: JSON.stringify({
        state,
        key: 'sk-bf16-v1-livekey',
        ref: 'MYREF1',
        name: 'CLI · macOS',
      }),
    });
    assert.equal(goodRes.status, 200);
    const payload = await srv.waitForAuth();
    assert.equal(payload.key, 'sk-bf16-v1-livekey');
    assert.equal(payload.ref, 'MYREF1');
  } finally {
    srv.close();
  }
});

test('statusline formatting and install/undo work cleanly', () => {
  const line = formatStatuslineText({
    stdinPayload: {
      model: { id: 'zai-org/glm-5.3-uncensored[1m]' },
      context_window: { used_percentage: 22 },
    },
    me: { balance: { available_usd: 14.25 }, tier: { id: 2 } },
  });
  assert.match(line, /bf16 · glm-5\.3\[1m\] · ctx 22% · bal \$14\.25 T2/);

  const lowLine = formatStatuslineText({
    me: { balance: { available_usd: 0.04 }, tier: { id: 0 } },
  });
  assert.match(lowLine, /LOW \$0\.040 T0/);

  const home = makeTmpHome();
  try {
    const settingsPath = installClaudeStatusline({ homeDir: home });
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(parsed.statusLine.command, 'npx -y bf16 statusline');
    const undone = restoreBackupSession(null, home);
    assert.equal(undone.ok, true);
    assert.equal(fs.existsSync(settingsPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installSidecarSkill installs Claude + Codex skills and MCP config with rollback', () => {
  const home = makeTmpHome();
  const cwd = makeTmpHome();
  try {
    const { installed } = installSidecarSkill({
      client: 'all',
      withMcp: true,
      homeDir: home,
      cwd,
    });
    assert.equal(installed.length, 3);
    assert.equal(
      fs.existsSync(path.join(home, '.claude', 'skills', 'bf16', 'SKILL.md')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(home, '.codex', 'skills', 'bf16', 'SKILL.md')),
      true
    );
    const mcp = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.bf16.args, ['-y', 'bf16-mcp-server']);

    const undone = restoreBackupSession(null, home);
    assert.equal(undone.ok, true);
    assert.equal(fs.existsSync(path.join(cwd, '.mcp.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('selectSmartModel routes simple vs heavy prompts appropriately', () => {
  assert.equal(
    selectSmartModel(
      { messages: [{ role: 'user', content: 'Summarize this line.' }] },
      { fastModel: 'fast-m', proModel: 'pro-m' }
    ),
    'fast-m'
  );
  assert.equal(
    selectSmartModel(
      {
        messages: [{ role: 'user', content: 'x'.repeat(20_000) }],
      },
      { fastModel: 'fast-m', proModel: 'pro-m' }
    ),
    'pro-m'
  );
  assert.equal(
    selectSmartModel(
      { messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled' } },
      { fastModel: 'fast-m', proModel: 'pro-m' }
    ),
    'pro-m'
  );
});
