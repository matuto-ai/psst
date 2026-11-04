import { DatabaseSync, backup } from 'node:sqlite';
import { lstatSync, realpathSync, openSync, closeSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDECARS = ['-wal', '-shm', '-journal'];

/** SQLite-safe online snapshot. Never overwrites a destination or starts a broker. */
export async function backupDatabase(source, destination) {
  const from = resolve(source), to = resolve(destination);
  const sourceStat = lstatSync(from), targetParent = dirname(to), parentStat = lstatSync(targetParent);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || realpathSync(from) !== from) throw new Error('Source must be a local regular database file without symlinks.');
  if (!parentStat.isDirectory() || realpathSync(targetParent) !== targetParent || (parentStat.mode & 0o077) !== 0 || (process.getuid && parentStat.uid !== process.getuid())) throw new Error('Backup directory must be private and owned by the current operator.');
  // SQLite may create, truncate or remove companion files while opening a path.
  // Check both directions before opening either database: the source itself
  // could otherwise be mistaken for the destination's WAL or rollback journal.
  const sourcePaths = new Set([from, ...SIDECARS.map(suffix => from + suffix)]);
  if ([to, ...SIDECARS.map(suffix => to + suffix)].some(path => sourcePaths.has(path))) {
    throw new Error('Backup paths must not overlap a database or its SQLite sidecars.');
  }
  for (const suffix of SIDECARS) {
    try { lstatSync(to + suffix); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Backup destination has SQLite sidecars. Choose a new snapshot path.');
  }
  const fd = openSync(to, 'wx', 0o600);
  closeSync(fd);
  let db, snapshot;
  try {
    db = new DatabaseSync(from, { readOnly: true });
    await backup(db, to);
    snapshot = new DatabaseSync(to, { readOnly: true });
    if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Snapshot integrity check failed.');
    chmodSync(to, 0o600);
    return { ok: true };
  } catch (error) {
    try { unlinkSync(to); } catch {}
    throw error;
  } finally {
    snapshot?.close();
    db?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/backup.mjs SOURCE_DATABASE NEW_PRIVATE_SNAPSHOT');
    process.exitCode = 1;
  } else {
    try {
      await backupDatabase(process.argv[2], process.argv[3]);
      console.error('SQLite snapshot completed and integrity checked.');
    } catch {
      console.error('Snapshot failed. Check local paths, private directory permissions, and storage health. Existing destinations are never overwritten.');
      process.exitCode = 1;
    }
  }
}
