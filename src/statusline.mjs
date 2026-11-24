import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREDITS_URL } from './constants.mjs';
import { ensureBf16Home, getBf16Home, resolveApiKey } from './credentials.mjs';
import { fetchMe } from './api.mjs';
import {
  createBackupSession,
  finalizeBackupSession,
  recordFileBeforeWrite,
} from './backup.mjs';
import { c, formatUsd, printHeader, printInfo, printOk, printWarn } from './ui.mjs';

const CACHE_TTL_MS = 60_000;

export function getStatusCachePath(homeDir = os.homedir()) {
  return path.join(getBf16Home(homeDir), 'status-cache.json');
}

function readCachedMe(homeDir = os.homedir()) {
  try {
    const file = getStatusCachePath(homeDir);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      parsed &&
      typeof parsed.fetchedAt === 'number' &&
      Date.now() - parsed.fetchedAt < CACHE_TTL_MS &&
      parsed.data
    ) {
      return parsed.data;
    }
  } catch {
    // Ignore stale/corrupt cache
  }
  return null;
}

function writeCachedMe(data, homeDir = os.homedir()) {
  try {
    ensureBf16Home(homeDir);
    fs.writeFileSync(
      getStatusCachePath(homeDir),
      `${JSON.stringify({ fetchedAt: Date.now(), data })}\n`,
      { mode: 0o600 }
    );
  } catch {
    // Best-effort cache
  }
}

export function formatStatuslineText({ stdinPayload = null, me = null } = {}) {
  const parts = ['bf16'];

  const modelId =
    stdinPayload?.model?.display_name ||
    stdinPayload?.model?.id ||
    process.env.ANTHROPIC_MODEL ||
    null;
  if (modelId) {
    const shortModel = String(modelId)
      .replace(/^zai-org\//, '')
      .replace(/^deepseek\//, '')
      .replace(/^moonshotai\//, '')
      .replace(/-uncensored/g, '');
    parts.push(shortModel);
  }

  const ctxPct =
    stdinPayload?.context_window?.used_percentage ??
    (stdinPayload?.context_window?.total_input_tokens &&
    stdinPayload?.context_window?.context_window_size
      ? Math.round(
          (stdinPayload.context_window.total_input_tokens /
            stdinPayload.context_window.context_window_size) *
            100
        )
      : null);
  if (ctxPct != null && Number.isFinite(Number(ctxPct))) {
    parts.push(`ctx ${Math.round(Number(ctxPct))}%`);
  }

  if (me?.balance) {
    const avail = Number(me.balance.available_usd ?? 0);
    const tierId = me.tier?.id != null ? `T${me.tier.id}` : '';
    const balStr = `${formatUsd(avail, avail < 1 ? 3 : 2)}${tierId ? ` ${tierId}` : ''}`;
    if (avail < 0.1) {
      parts.push(`LOW ${balStr} → ${CREDITS_URL.replace(/^https?:\/\//, '')}`);
    } else {
      parts.push(`bal ${balStr}`);
    }
  } else {
    parts.push('ZDR 1M');
  }

  return parts.join(' · ');
}

function readStdinIfPiped(timeoutMs = 120) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.pause();
      resolve(data || null);
    }, timeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data || null);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export function installClaudeStatusline({ homeDir = os.homedir() } = {}) {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  const session = createBackupSession('statusline', homeDir);
  recordFileBeforeWrite(session, settingsPath);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let existing = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8') || '{}');
    } catch {
      finalizeBackupSession(session);
      throw new Error(`${settingsPath} contains invalid JSON; refusing to overwrite.`);
    }
  }

  const next = {
    ...existing,
    statusLine: {
      type: 'command',
      command: 'npx -y bf16ai statusline',
      padding: 0,
    },
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  finalizeBackupSession(session);
  return settingsPath;
}

export async function runStatusline({ install = false, flagKey = null, homeDir = os.homedir() } = {}) {
  if (install) {
    printHeader('statusline', 'Install live bf16 balance & context bar into Claude Code');
    try {
      const target = installClaudeStatusline({ homeDir });
      printOk(`Updated ${c.dim(target)}`);
      printInfo(`Undo anytime: ${c.cyan('npx bf16ai undo')}`);
    } catch (err) {
      printWarn(err.message);
      process.exitCode = 1;
    }
    return;
  }

  const rawStdin = await readStdinIfPiped();
  let stdinPayload = null;
  if (rawStdin) {
    try {
      stdinPayload = JSON.parse(rawStdin);
    } catch {
      stdinPayload = null;
    }
  }

  const resolved = resolveApiKey({ flagKey, homeDir });
  let me = readCachedMe(homeDir);
  if (!me && resolved.key) {
    const res = await fetchMe(resolved.key, { timeoutMs: 1500 });
    if (res.ok && res.data) {
      me = res.data;
      writeCachedMe(me, homeDir);
    }
  }

  console.log(formatStatuslineText({ stdinPayload, me }));
}
