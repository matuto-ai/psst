import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { backupDatabase } from '../scripts/backup.mjs';
import { fixture } from './helpers.mjs';

const sidecars = ['-wal', '-shm', '-journal'];
function privateDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'broker-backup-')); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function closedSource(path, mode) {
  const db = new DatabaseSync(path);
  try { db.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE saved(value); INSERT INTO saved VALUES(42);`); }
  finally { db.close(); }
}
function assertReadable(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(db.prepare('SELECT value FROM saved').get().value, 42); }
  finally { db.close(); }
}

test('online backup includes committed WAL data and never mutates live identities', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-backup-')); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.sqlite'), dest = join(dir, 'snapshot.sqlite');
  const db = new DatabaseSync(source); t.after(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE sessions(id TEXT, epoch INTEGER); INSERT INTO sessions VALUES('fixture-session',7); CREATE TABLE messages(id TEXT,state TEXT); INSERT INTO messages VALUES('fixture-message','claimed');");
  assert.deepEqual(await backupDatabase(source, dest), { ok: true });
  const snapshot = new DatabaseSync(dest, { readOnly: true }); t.after(() => snapshot.close());
  assert.equal(snapshot.prepare('SELECT epoch FROM sessions').get().epoch, 7);
  assert.equal(snapshot.prepare('SELECT state FROM messages').get().state, 'claimed');
  assert.equal(db.prepare('SELECT epoch FROM sessions').get().epoch, 7);
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  const before = readFileSync(dest);
  await assert.rejects(backupDatabase(source, dest));
  assert.deepEqual(readFileSync(dest), before);
});

test('backup rejects symlinks, public directories and non-database sources safely', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-backup-')); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.sqlite'), dest = join(dir, 'snapshot.sqlite');
  const db = new DatabaseSync(source); db.exec('CREATE TABLE fixture(id INTEGER)'); db.close();
  const link = join(dir, 'source-link'); symlinkSync(source, link);
  await assert.rejects(backupDatabase(link, dest));
  chmodSync(dir, 0o755);
  await assert.rejects(backupDatabase(source, dest));
  chmodSync(dir, 0o700);
  const plain = join(dir, 'not-sqlite'); writeFileSync(plain, 'not a database');
  await assert.rejects(backupDatabase(plain, dest));
  assert.throws(() => statSync(dest), { code: 'ENOENT' });
  await assert.rejects(backupDatabase(source, source));
});

test('backup rejects SQLite companion aliases in both directions without changing the source', async t => {
  for (const mode of ['DELETE', 'WAL']) for (const suffix of sidecars) for (const direction of ['source-sidecar', 'destination-sidecar']) {
    const dir = privateDirectory(t), base = join(dir, 'snapshot.sqlite');
    const source = direction === 'source-sidecar' ? base : base + suffix;
    const destination = direction === 'source-sidecar' ? base + suffix : base;
    closedSource(source, mode);
    const before = readFileSync(source);
    await assert.rejects(backupDatabase(source, destination), /must not overlap/);
    assert.deepEqual(readFileSync(source), before, `${mode} ${direction} ${suffix}: source bytes unchanged`);
    assert.deepEqual(readdirSync(dir), [basename(source)], 'no snapshot or companion file was created');
    assertReadable(source);
  }
});

test('backup preserves existing destination companion files in both SQLite journal modes', async t => {
  for (const mode of ['DELETE', 'WAL']) for (const suffix of sidecars) {
    const dir = privateDirectory(t), source = join(dir, 'source.sqlite'), destination = join(dir, 'snapshot.sqlite');
    closedSource(source, mode);
    const before = readFileSync(source), companion = destination + suffix;
    writeFileSync(companion, 'unrelated existing companion', { mode: 0o600 });
    await assert.rejects(backupDatabase(source, destination), /destination has SQLite sidecars/);
    assert.equal(readFileSync(companion, 'utf8'), 'unrelated existing companion');
    assert.deepEqual(readFileSync(source), before);
    assert.throws(() => lstatSync(destination), { code: 'ENOENT' });
    assertReadable(source);
  }
});

test('backup rejects broken symlinks and directories at destination companion paths', async t => {
  for (const suffix of sidecars) for (const kind of ['symlink', 'directory']) {
    const dir = privateDirectory(t), source = join(dir, 'source.sqlite'), destination = join(dir, 'snapshot.sqlite');
    closedSource(source, 'WAL');
    const companion = destination + suffix;
    if (kind === 'symlink') symlinkSync(join(dir, 'missing-target'), companion);
    else mkdirSync(companion, { mode: 0o700 });
    await assert.rejects(backupDatabase(source, destination), /destination has SQLite sidecars/);
    assert.equal(kind === 'symlink' ? lstatSync(companion).isSymbolicLink() : lstatSync(companion).isDirectory(), true);
    assert.throws(() => lstatSync(destination), { code: 'ENOENT' });
    assertReadable(source);
  }
});

test('store backups use the same no-overwrite and companion protections', async t => {
  const f = fixture(t), destination = join(f.dir, 'snapshot.sqlite');
  closedSource(destination, 'DELETE');
  const before = readFileSync(destination);
  await assert.rejects(f.store.backup(destination), { code: 'EEXIST' });
  assert.deepEqual(readFileSync(destination), before);
  assertReadable(destination);
  for (const suffix of sidecars) await assert.rejects(f.store.backup(f.path + suffix), /must not overlap/);
  const alternate = join(f.dir, 'another.sqlite');
  writeFileSync(alternate + '-wal', 'existing companion', { mode: 0o600 });
  await assert.rejects(f.store.backup(alternate), /destination has SQLite sidecars/);
  assert.equal(readFileSync(alternate + '-wal', 'utf8'), 'existing companion');
  assert.throws(() => lstatSync(alternate), { code: 'ENOENT' });
  assert.equal(f.store.safe(), true);
  f.store.close();
  await assert.rejects(f.store.backup(join(f.dir, 'closed.sqlite')), /store is closed/);
});
