import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  APP_ORIGIN,
  CLI_AUTH_URL,
  CREDITS_URL,
  KEYS_URL,
  REFERRALS_URL,
} from './constants.mjs';
import {
  clearCredentials,
  getCredentialsPath,
  loadCredentials,
  resolveApiKey,
  saveCredentials,
} from './credentials.mjs';
import { fetchMe } from './api.mjs';
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

export function buildCliAuthUrl({ callbackUrl, state, device, ref }) {
  const url = new URL(CLI_AUTH_URL);
  url.searchParams.set('callback', callbackUrl);
  url.searchParams.set('state', state);
  if (device) url.searchParams.set('device', device);
  if (ref && /^[A-Za-z0-9_-]{3,32}$/.test(ref.trim())) {
    url.searchParams.set('ref', ref.trim());
  }
  return url.toString();
}

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const appHost = new URL(APP_ORIGIN).hostname;
    if (parsed.hostname === appHost) return true;
    if (parsed.hostname === 'bf16.ai' || parsed.hostname === 'www.bf16.ai') {
      return true;
    }
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function openInBrowser(url) {
  try {
    const platform = process.platform;
    let cmd;
    let args;
    if (platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function successHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>bf16 CLI Authorized</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #FAF7F0; color: #141111; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { border: 2px solid #141111; border-radius: 16px; background: #fff; padding: 28px 32px; max-width: 440px; box-shadow: 5px 5px 0 #141111; }
    .badge { display: inline-block; background: #5EEAD4; border: 2px solid #141111; border-radius: 999px; padding: 2px 10px; font-size: 11px; font-weight: 800; }
    h1 { font-size: 20px; margin: 14px 0 8px; }
    p { font-size: 13px; line-height: 1.6; color: #444; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">BF16 CLI · CONNECTED</span>
    <h1>You are signed in.</h1>
    <p>Your API key was saved locally with <code>0600</code> permissions. You can close this tab and return to your terminal.</p>
  </div>
  <script>try { history.replaceState(null, '', '/done'); } catch {}</script>
</body>
</html>`;
}

/**
 * Starts a local loopback server on 127.0.0.1 to receive the minted API key
 * from `https://bf16.ai/cli-auth` via POST (JSON/form) or GET callback.
 */
export function startLoopbackAuthServer({ expectedState, port = 0, timeoutMs = 180_000 }) {
  return new Promise((resolveStart, rejectStart) => {
    let settled = false;
    let resolvePayload;
    let rejectPayload;

    const payloadPromise = new Promise((res, rej) => {
      resolvePayload = res;
      rejectPayload = rej;
    });

    const server = http.createServer((req, res) => {
      const origin = req.headers.origin;
      if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Vary', 'Origin');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const finishWith = (payload, respondAsJson) => {
        if (!payload?.key || !timingSafeEqualStr(payload.state || '', expectedState)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid state or missing key' }));
          return;
        }
        if (respondAsJson) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(successHtml());
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          server.close();
          resolvePayload(payload);
        }
      };

      if (req.method === 'GET') {
        finishWith(
          {
            state: reqUrl.searchParams.get('state') || '',
            key: reqUrl.searchParams.get('key') || '',
            ref: reqUrl.searchParams.get('ref') || null,
            keyName: reqUrl.searchParams.get('name') || null,
          },
          false
        );
        return;
      }

      if (req.method === 'POST') {
        const chunks = [];
        let totalBytes = 0;
        req.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes <= 16_384) chunks.push(chunk);
        });
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const contentType = (req.headers['content-type'] || '').toLowerCase();
          let payload = null;
          if (contentType.includes('application/json')) {
            try {
              payload = JSON.parse(raw);
            } catch {
              payload = null;
            }
            finishWith(payload, true);
          } else {
            const params = new URLSearchParams(raw);
            payload = {
              state: params.get('state') || '',
              key: params.get('key') || '',
              ref: params.get('ref') || null,
              keyName: params.get('name') || null,
            };
            finishWith(payload, false);
          }
        });
        return;
      }

      res.writeHead(405);
      res.end();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        rejectPayload(new Error('Login timed out waiting for browser authorization.'));
      }
    }, timeoutMs);

    server.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectStart(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolveStart({
        port: boundPort,
        callbackUrl: `http://127.0.0.1:${boundPort}/callback`,
        waitForAuth: () => payloadPromise,
        close: () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            server.close();
          }
        },
      });
    });
  });
}

export async function verifyAndSaveKey({ apiKey, referralCode = null, keyName = null }) {
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) {
    throw new Error('API key is empty.');
  }
  const me = await fetchMe(trimmed);
  if (!me.ok) {
    throw new Error(
      `API key verification failed (${me.status || 'network'}: ${me.error}).`
    );
  }
  const { filePath } = saveCredentials({
    apiKey: trimmed,
    ...(referralCode ? { referralCode } : {}),
    ...(keyName ? { keyName } : {}),
  });
  return { filePath, me: me.data, latencyMs: me.latencyMs };
}

export async function runLogin({
  flagKey = null,
  ref = null,
  noBrowser = false,
  port = 0,
  quiet = false,
} = {}) {
  if (flagKey) {
    const result = await verifyAndSaveKey({ apiKey: flagKey });
    if (!quiet) {
      printHeader('login', 'API key verified and saved locally');
      printOk(`Saved to ${c.dim(result.filePath)} (mode 0600)`);
      printBalanceSummary(result.me);
    }
    return { apiKey: flagKey.trim(), me: result.me };
  }

  if (!quiet) {
    printHeader('login', 'Sign in to bf16.ai (Zero Data Retention · $0.20 starter credit)');
  }

  const state = crypto.randomBytes(24).toString('hex');
  const device = `${os.hostname().slice(0, 32)} (${process.platform})`;
  let loopback = null;

  try {
    loopback = await startLoopbackAuthServer({
      expectedState: state,
      port: Number(port) || 0,
    });
  } catch (err) {
    printWarn(`Could not bind localhost callback (${err.message}). Falling back to manual key entry.`);
  }

  if (loopback) {
    const authUrl = buildCliAuthUrl({
      callbackUrl: loopback.callbackUrl,
      state,
      device,
      ref,
    });

    if (!noBrowser) {
      const opened = openInBrowser(authUrl);
      if (opened) {
        printInfo('Opened browser to authorize this terminal...');
      } else {
        printInfo('Open this URL in your browser to authorize:');
      }
    } else {
      printInfo('Open this URL in your browser to authorize:');
    }
    console.log(`    ${c.cyan(authUrl)}`);
    console.log('');
    console.log(
      c.dim(`  Waiting for browser callback (or paste an existing key from ${KEYS_URL} below)...`)
    );

    // Allow either browser callback OR direct paste in TTY so SSH/headless users are never stuck
    let rl = null;
    const pastePromise =
      process.stdin.isTTY && !process.env.CI
        ? new Promise((resolve) => {
            rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            rl.question(c.dim('  Or paste sk-bf16-... and press Enter: '), (ans) => {
              rl?.close();
              rl = null;
              if (ans.trim()) {
                resolve({ key: ans.trim(), manual: true });
              }
            });
          })
        : new Promise(() => {});

    try {
      const result = await Promise.race([loopback.waitForAuth(), pastePromise]);
      if (rl) {
        rl.close();
        rl = null;
      }
      loopback.close();
      console.log('');
      const saved = await verifyAndSaveKey({
        apiKey: result.key,
        referralCode: result.ref || null,
        keyName: result.keyName || null,
      });
      printOk(`Authenticated! Saved to ${c.dim(saved.filePath)} (mode 0600)`);
      printBalanceSummary(saved.me);
      if (result.ref) {
        printInfo(
          `Share & earn credit: ${c.cyan(`npx bf16ai claude --ref=${result.ref}`)}`
        );
      }
      return { apiKey: result.key, me: saved.me };
    } catch (err) {
      if (rl) rl.close();
      loopback.close();
      throw err;
    }
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `No API key found. Run \`npx bf16ai login --key <sk-bf16-...>\` or set BF16_API_KEY. Keys: ${KEYS_URL}`
    );
  }

  console.log(`  Get a key at ${c.cyan(KEYS_URL)}`);
  const pasted = await promptLine('  Paste your BF16_API_KEY: ');
  const saved = await verifyAndSaveKey({ apiKey: pasted });
  printOk(`Authenticated! Saved to ${c.dim(saved.filePath)} (mode 0600)`);
  printBalanceSummary(saved.me);
  return { apiKey: pasted, me: saved.me };
}

export async function ensureApiKey({ flagKey = null, ref = null } = {}) {
  const resolved = resolveApiKey({ flagKey });
  if (resolved.key) {
    return resolved.key;
  }
  const loginRes = await runLogin({ ref });
  return loginRes.apiKey;
}

export function printBalanceSummary(me) {
  if (!me) return;
  const avail = Number(me.balance?.available_usd ?? 0);
  const reserved = Number(me.balance?.reserved_usd ?? 0);
  const tierName = me.tier?.name || `Tier ${me.tier?.id ?? 0}`;
  const concLimit = me.concurrency?.limit ?? me.tier?.max_concurrent_requests ?? '-';
  const concUsed = me.concurrency?.in_use ?? 0;
  const rpm = me.tier?.requests_per_minute ?? '-';

  printOk(
    `Balance: ${c.bold(avail < 0.1 ? c.yellow(formatUsd(avail, 4)) : c.green(formatUsd(avail, 4)))}` +
      (reserved > 0 ? c.dim(` (${formatUsd(reserved, 4)} reserved)`) : '') +
      ` · ${c.bold(tierName)} · Concurrency ${concUsed}/${concLimit} · ${rpm} RPM`
  );
  if (me.next_tier && me.next_tier.top_up_needed_usd > 0) {
    printInfo(
      `Next tier (${me.next_tier.name}, ${me.next_tier.max_concurrent_requests} concurrent): ` +
        `top up ${formatUsd(me.next_tier.top_up_needed_usd, 2)} at ${c.cyan(CREDITS_URL)}`
    );
  } else if (avail < 0.1) {
    printWarn(`Low balance! Top up anytime at ${c.cyan(CREDITS_URL)}`);
  }
}

export async function runWhoami({ flagKey = null, json = false } = {}) {
  const resolved = resolveApiKey({ flagKey });
  if (!resolved.key) {
    if (json) {
      console.log(JSON.stringify({ authenticated: false }, null, 2));
      process.exitCode = 1;
      return;
    }
    printHeader('whoami');
    printErr('Not logged in.');
    printInfo(`Run ${c.cyan('npx bf16ai login')} or set ${c.cyan('BF16_API_KEY')}.`);
    process.exitCode = 1;
    return;
  }

  const me = await fetchMe(resolved.key);
  if (json) {
    console.log(
      JSON.stringify(
        {
          authenticated: me.ok,
          source: resolved.source,
          key: maskApiKey(resolved.key),
          latencyMs: me.latencyMs,
          account: me.data || null,
          error: me.error || null,
        },
        null,
        2
      )
    );
    if (!me.ok) process.exitCode = 1;
    return;
  }

  printHeader('account', `Key ${maskApiKey(resolved.key)} (${resolved.source}) · ${me.latencyMs}ms`);
  if (!me.ok) {
    printErr(`API check failed: ${me.error}`);
    process.exitCode = 1;
    return;
  }
  printBalanceSummary(me.data);
  if (resolved.referralCode) {
    printInfo(`Referral command: ${c.cyan(`npx bf16ai claude --ref=${resolved.referralCode}`)}`);
  }
}

export function runLogout() {
  const removed = clearCredentials();
  printHeader('logout');
  if (removed) {
    printOk(`Removed ${c.dim(getCredentialsPath())}`);
  } else {
    printInfo('No saved credentials found.');
  }
  if (process.env.BF16_API_KEY) {
    printWarn('Note: BF16_API_KEY is still set in your shell environment.');
  }
}

export function runReferral({ code = null } = {}) {
  const creds = loadCredentials();
  const refCode = code || creds?.referralCode || null;
  printHeader('referral', 'Invite friends to bf16.ai — they get +20% bonus on first top-up');
  if (!refCode) {
    printInfo(`Find your personal referral code at ${c.cyan(REFERRALS_URL)}`);
    printInfo(`Or re-authenticate via ${c.cyan('npx bf16ai login')} to sync it automatically.`);
    return;
  }
  console.log('');
  console.log(`  ${c.bold('One-command Claude Code invite:')}`);
  console.log(`    ${c.cyan(`npx bf16ai claude --ref=${refCode}`)}`);
  console.log('');
  console.log(`  ${c.bold('One-command Auto-Setup invite:')}`);
  console.log(`    ${c.cyan(`npx bf16ai setup --ref=${refCode}`)}`);
  console.log('');
  console.log(`  ${c.bold('Direct web link:')}`);
  console.log(`    ${c.cyan(`${APP_ORIGIN}/?ref=${refCode}`)}`);
  console.log('');
}
