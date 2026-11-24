import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getBf16Home(homeDir = os.homedir()) {
  if (process.env.BF16_HOME) {
    return path.resolve(process.env.BF16_HOME);
  }
  return path.join(homeDir, '.bf16');
}

export function getCredentialsPath(homeDir = os.homedir()) {
  return path.join(getBf16Home(homeDir), 'credentials.json');
}

export function ensureBf16Home(homeDir = os.homedir()) {
  const dir = getBf16Home(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Ignore on platforms where chmod is unsupported
  }
  return dir;
}

export function loadCredentials(homeDir = os.homedir()) {
  const filePath = getCredentialsPath(homeDir);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCredentials(data, homeDir = os.homedir()) {
  ensureBf16Home(homeDir);
  const filePath = getCredentialsPath(homeDir);
  const existing = loadCredentials(homeDir) || {};
  const merged = {
    ...existing,
    ...data,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore on Windows
  }
  return { filePath, credentials: merged };
}

export function clearCredentials(homeDir = os.homedir()) {
  const filePath = getCredentialsPath(homeDir);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Resolves the active bf16 API key in precedence order:
 * 1. Explicit CLI flag (`--key`)
 * 2. Environment variable (`BF16_API_KEY`)
 * 3. Stored credentials file (`~/.bf16/credentials.json`)
 */
export function resolveApiKey({ flagKey, env = process.env, homeDir } = {}) {
  if (flagKey && String(flagKey).trim()) {
    return { key: String(flagKey).trim(), source: 'flag' };
  }
  if (env.BF16_API_KEY && String(env.BF16_API_KEY).trim()) {
    return { key: String(env.BF16_API_KEY).trim(), source: 'env' };
  }
  const creds = loadCredentials(homeDir);
  if (creds?.apiKey && String(creds.apiKey).trim()) {
    return {
      key: String(creds.apiKey).trim(),
      source: 'credentials',
      referralCode: creds.referralCode || null,
      keyName: creds.keyName || null,
    };
  }
  return { key: null, source: null };
}
