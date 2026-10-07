const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('../src/main/backup/snapshotStore');
const coordinator = require('../src/main/backup/backupCoordinator');

async function sandbox(t) {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'gsm-local-test-'),
  );
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(root, folder, metadata = {}, content = 'save') {
  const directory = path.join(root, '123', folder);
  await fs.promises.mkdir(path.join(directory, 'path1'), { recursive: true });
  await fs.promises.writeFile(
    path.join(directory, 'path1', 'save.dat'),
    content,
  );
  await fs.promises.writeFile(
    path.join(directory, 'backup_info.json'),
    JSON.stringify({
      title: 'Game',
      backup_paths: [
        {
          folder_name: 'path1',
          template: '{{p|appdata}}\\Game',
          type: 'folder',
        },
      ],
      ...metadata,
    }),
  );
  return directory;
}

test('same-millisecond snapshots have distinct UUID folders', () => {
  const now = new Date('2026-10-05T06:00:00.123Z');
  const first = store.newSnapshotIdentity(now);
  const second = store.newSnapshotIdentity(now);
  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.notEqual(first.folder, second.folder);
  assert.equal(first.createdAt, '2026-10-05T06:00:00.123Z');
});

test('discovery normalizes legacy dates and sorts by metadata while hiding staging', async (t) => {
  const root = await sandbox(t);
  await fixture(root, '2025-01-01_12-00');
  const id = store.newSnapshotIdentity(new Date('2026-10-05T06:00:00Z'));
  await fixture(root, id.folder, id);
  await fixture(root, '.pending-hidden', id);
  await fs.promises.mkdir(path.join(root, '123', 'incomplete'));
  const snapshots = await store.listSnapshots(root, '123');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].snapshotId, id.snapshotId);
  assert.equal(snapshots[1].metadata.legacyDate, '2025-01-01_12-00');
  assert.equal(snapshots[1].metadata.timezoneUncertain, true);
});

test('identity upgrades are durable and concurrent upgrades preserve the first ID', async (t) => {
  const root = await sandbox(t);
  await fixture(root, '2025-01-01_12-00');
  const old = await store.readSnapshot(root, '123', '2025-01-01_12-00');
  const device = crypto.randomUUID();
  const [first, second] = await Promise.all([
    store.ensureIdentity(old, device),
    store.ensureIdentity(old, device),
  ]);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(
    (await store.readSnapshot(root, '123', old.folder)).metadata.originDeviceId,
    device,
  );
});

test('metadata paths and game identities cannot escape the snapshot root', async (t) => {
  const root = await sandbox(t);
  await assert.rejects(store.readSnapshot(root, '../outside', 'x'), /game ID/);
  await assert.rejects(
    store.readSnapshot(root, '123', '../outside'),
    /snapshot/,
  );
  await fixture(root, '2025-01-01_12-00', {
    backup_paths: [{ folder_name: '..', template: 'x', type: 'folder' }],
  });
  assert.equal((await store.listSnapshots(root)).length, 0);
});

test('same-game operations serialize even after failure and other games run independently', async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = coordinator.withGameLock('124', async () => {
    events.push('first');
    await gate;
    throw new Error('failed');
  });
  const second = coordinator.withGameLock('124', () => events.push('second'));
  await coordinator.withGameLock('125', () => events.push('other'));
  assert.deepEqual(events, ['first', 'other']);
  release();
  await assert.rejects(first, /failed/);
  await second;
  assert.deepEqual(events, ['first', 'other', 'second']);
});

test('rotation preserves pinned, restore protection, pending intents and reader references', async (t) => {
  const root = await sandbox(t);
  const pinned = await fixture(root, '2025-01-01_12-00', {
    is_permanent: true,
  });
  const pending = await fixture(root, '2025-01-02_12-00', {
    cloudUploadIntent: { targetId: 'target' },
  });
  const reader = await fixture(root, '2025-01-03_12-00');
  const old = await fixture(root, '2025-01-04_12-00');
  const latest = await fixture(root, '2025-01-05_12-00');
  const release = coordinator.protectSnapshot(reader);
  await coordinator.rotateSnapshots(root, '123', 1);
  for (const directory of [pinned, pending, reader, latest])
    assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.existsSync(old), false);
  release();
  release();
  assert.equal(coordinator.isProtected(reader), false);
  await coordinator.rotateSnapshots(root, '123', 1);
  assert.equal(fs.existsSync(reader), false);
});

test('imports deduplicate by identity and content; conflicting identity is quarantined', async (t) => {
  const root = await sandbox(t);
  const stagingRoot = await sandbox(t);
  const id = store.newSnapshotIdentity();
  const staged = await fixture(stagingRoot, id.folder, {
    ...id,
    gameKey: 'pcgw:123',
  });
  const metadata = (await store.readSnapshot(stagingRoot, '123', id.folder))
    .metadata;
  const imported = await store.importSnapshot(root, staged, metadata);
  assert.equal(imported.snapshot.metadata.cloudImported, true);
  assert.equal(
    (await store.importSnapshot(root, staged, metadata)).duplicate,
    true,
  );
  await fs.promises.writeFile(
    path.join(staged, 'path1', 'save.dat'),
    'different',
  );
  const conflict = await store.importSnapshot(root, staged, metadata);
  assert.equal(conflict.conflict, true);
  assert.equal(fs.existsSync(conflict.quarantinedPath), true);
  assert.equal((await store.listSnapshots(root)).length, 1);
  assert.equal(
    await fs.promises.readFile(
      path.join(imported.snapshot.path, 'path1', 'save.dat'),
      'utf8',
    ),
    'save',
  );
});

test('content digest ignores labels but includes actual .tmp and hidden save files', async (t) => {
  const root = await sandbox(t);
  const directory = await fixture(root, '2025-01-01_12-00');
  const snapshot = await store.readSnapshot(root, '123', '2025-01-01_12-00');
  const first = await store.computeContentHash(directory, snapshot.metadata);
  assert.equal(
    await store.computeContentHash(directory, {
      ...snapshot.metadata,
      custom_name: 'edited',
      is_permanent: true,
    }),
    first,
  );
  await fs.promises.writeFile(
    path.join(directory, 'path1', '.hidden.tmp'),
    'progress',
  );
  assert.notEqual(
    await store.computeContentHash(directory, snapshot.metadata),
    first,
  );
});
