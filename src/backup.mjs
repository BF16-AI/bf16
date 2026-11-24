import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureBf16Home, getBf16Home } from './credentials.mjs';

export function getBackupsRoot(homeDir = os.homedir()) {
  return path.join(getBf16Home(homeDir), 'backups');
}

export function createBackupSession(label = 'setup', homeDir = os.homedir()) {
  ensureBf16Home(homeDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}-${label}`;
  const dir = path.join(getBackupsRoot(homeDir), id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    id,
    label,
    dir,
    createdAt: new Date().toISOString(),
    entries: [],
  };
}

/**
 * Backs up `targetPath` before mutating or creating it.
 * Deduplicates by resolved path inside the same backup session so the
 * original pre-setup contents are always preserved.
 */
export function recordFileBeforeWrite(session, targetPath) {
  const abs = path.resolve(targetPath);
  if (session.entries.some((e) => e.targetPath === abs)) {
    return;
  }

  const existed = fs.existsSync(abs);
  let backupFile = null;
  if (existed) {
    const idx = session.entries.length;
    const safeName = `${String(idx).padStart(2, '0')}-${path.basename(abs)}`;
    backupFile = safeName;
    fs.copyFileSync(abs, path.join(session.dir, safeName));
  }

  session.entries.push({
    targetPath: abs,
    existed,
    backupFile,
  });
}

export function finalizeBackupSession(session) {
  if (session.entries.length === 0) {
    fs.rmSync(session.dir, { recursive: true, force: true });
    return null;
  }
  const manifestPath = path.join(session.dir, 'manifest.json');
  const manifest = {
    id: session.id,
    label: session.label,
    createdAt: session.createdAt,
    entries: session.entries,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return manifest;
}

export function listBackupSessions(homeDir = os.homedir()) {
  const root = getBackupsRoot(homeDir);
  if (!fs.existsSync(root)) return [];
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  const manifests = [];
  for (const name of names) {
    const manifestPath = path.join(root, name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifests.push({
        ...parsed,
        dir: path.join(root, name),
      });
    } catch {
      // Skip corrupted manifest
    }
  }
  return manifests;
}

export function restoreBackupSession(sessionId = null, homeDir = os.homedir()) {
  const sessions = listBackupSessions(homeDir);
  if (sessions.length === 0) {
    return { ok: false, reason: 'no_backups', restored: [], removed: [] };
  }

  const target = sessionId
    ? sessions.find((s) => s.id === sessionId)
    : sessions[0];
  if (!target) {
    return { ok: false, reason: 'not_found', restored: [], removed: [] };
  }

  const restored = [];
  const removed = [];

  for (const entry of [...target.entries].reverse()) {
    if (entry.existed && entry.backupFile) {
      const src = path.join(target.dir, entry.backupFile);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(entry.targetPath), { recursive: true });
        fs.copyFileSync(src, entry.targetPath);
        restored.push(entry.targetPath);
      }
    } else if (!entry.existed) {
      if (fs.existsSync(entry.targetPath)) {
        fs.unlinkSync(entry.targetPath);
        removed.push(entry.targetPath);
      }
    }
  }

  fs.rmSync(target.dir, { recursive: true, force: true });

  return {
    ok: true,
    session: target,
    restored,
    removed,
  };
}
