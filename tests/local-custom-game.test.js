const test = require('node:test');
const assert = require('node:assert/strict');
const fs = (() => {
  try {
    return require('original-fs');
  } catch {
    return require('node:fs');
  }
})();
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { setImmediate: nextTurn } = require('node:timers/promises');
const custom = require('../src/main/games/customGameStore');
const snapshots = require('../src/main/backup/snapshotStore');

async function fixture(t) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'gsm-custom-game-test-'),
  );
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return { root, filename: path.join(root, 'custom_entries.json') };
}

function definition(gameId = randomUUID(), title = 'Custom game') {
  return {
    wiki_page_id: gameId,
    title,
    install_folder: 'Old local install',
    save_location: {
      win: [{ template: 'old local path', type: 'folder' }],
      reg: [],
      mac: [],
      linux: [],
    },
  };
}

function imported(
  root,
  { gameId = randomUUID(), title = 'Custom game', types = ['file'] } = {},
) {
  const backup_paths = types.map((type, index) => ({
    folder_name: `path${index + 1}`,
    type,
    template: `untrusted-remote-path-${index}`,
  }));
  const snapshot = {
    gameId,
    root,
    metadata: {
      cloudImported: true,
      gameKey: `custom:${gameId}`,
      title,
      backup_paths,
      customDefinition: {
        ...definition(gameId, 'Remote definition title'),
        install_folder: 'UNTRUSTED_INSTALL',
        save_location: { win: [{ template: 'UNTRUSTED_SAVE', type: 'file' }] },
        autoBackupGames: { [gameId]: { mode: 'watcher' } },
      },
    },
  };
  const plan = backup_paths.map((entry, index) => ({
    entry,
    backupType: entry.type,
    destinationPath:
      entry.type === 'reg'
        ? 'HKEY_CURRENT_USER\\Software\\Confirmed Game'
        : path.join(root, `confirmed-${index}`),
  }));
  return { snapshot, plan };
}

test('cloud custom restore uses confirmed destinations and preserves UUID, title and unrelated definitions', async (t) => {
  const x = await fixture(t);
  const other = definition(randomUUID(), 'Unrelated game');
  await custom.updateCustomEntries(x.root, () => [other]);
  const { snapshot, plan } = imported(x.root, {
    types: ['file', 'folder', 'reg'],
  });
  const result = await custom.registerRestoredCustomGame(
    x.root,
    snapshot,
    plan,
    { platform: 'win32' },
  );
  assert.deepEqual(result, { status: 'registered' });
  const entries = await custom.readCustomEntries(x.root);
  assert.deepEqual(entries[0], other);
  assert.deepEqual(entries[1], {
    title: snapshot.metadata.title,
    wiki_page_id: snapshot.gameId,
    install_folder: '',
    save_location: {
      win: [
        { template: plan[0].destinationPath, type: 'file' },
        { template: plan[1].destinationPath, type: 'folder' },
      ],
      reg: [{ template: plan[2].destinationPath, type: null }],
      mac: [],
      linux: [],
    },
  });
  assert.doesNotMatch(
    JSON.stringify(entries),
    /UNTRUSTED|autoBackup|watcher|Remote definition title/,
  );
});

test('same UUID preserves the exact existing file; same title with another UUID coexists', async (t) => {
  const x = await fixture(t);
  const existing = definition();
  const original = JSON.stringify([existing]);
  await fs.promises.writeFile(x.filename, original);
  const same = imported(x.root, {
    gameId: existing.wiki_page_id,
    title: 'Changed remotely',
  });
  assert.deepEqual(
    await custom.registerRestoredCustomGame(x.root, same.snapshot, same.plan),
    { status: 'existing' },
  );
  assert.equal(await fs.promises.readFile(x.filename, 'utf8'), original);
  const renamedId = imported(x.root, { title: existing.title });
  assert.deepEqual(
    await custom.registerRestoredCustomGame(
      x.root,
      renamedId.snapshot,
      renamedId.plan,
    ),
    { status: 'registered' },
  );
  const entries = await custom.readCustomEntries(x.root);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, entries[1].title);
  assert.notEqual(entries[0].wiki_page_id, entries[1].wiki_page_id);
  assert.deepEqual(entries[0], existing);
});

test('missing files read as empty and non-cloud or non-custom snapshots never register', async (t) => {
  const x = await fixture(t);
  assert.deepEqual(await custom.readCustomEntries(x.root), []);
  for (const change of [
    (value) => {
      value.metadata.cloudImported = false;
    },
    (value) => {
      value.gameId = '123';
      value.metadata.gameKey = 'pcgw:123';
    },
    (value) => {
      delete value.metadata.customDefinition;
    },
  ]) {
    const candidate = imported(x.root);
    change(candidate.snapshot);
    assert.equal(
      await custom.registerRestoredCustomGame(
        x.root,
        candidate.snapshot,
        candidate.plan,
      ),
      null,
    );
  }
  assert.equal(fs.existsSync(x.filename), false);
});

test('malformed existing JSON or entry schema is preserved and reported without overwriting', async (t) => {
  const x = await fixture(t);
  for (const bytes of ['{broken', '{}', '[{"title":"Missing identity"}]']) {
    await fs.promises.writeFile(x.filename, bytes);
    const { snapshot, plan } = imported(x.root);
    assert.deepEqual(
      await custom.registerRestoredCustomGame(x.root, snapshot, plan),
      { status: 'failed', code: 'CUSTOM_ENTRIES_CORRUPT' },
    );
    await assert.rejects(custom.readCustomEntries(x.root), {
      code: 'CUSTOM_ENTRIES_CORRUPT',
    });
    await assert.rejects(
      custom.updateCustomEntries(x.root, () => []),
      { code: 'CUSTOM_ENTRIES_CORRUPT' },
    );
    assert.equal(await fs.promises.readFile(x.filename, 'utf8'), bytes);
  }
});

test('a failed atomic commit retains the original file and removes its temporary file', async (t) => {
  const x = await fixture(t);
  const original = JSON.stringify([definition()]);
  await fs.promises.writeFile(x.filename, original);
  const rename = fs.promises.rename.bind(fs.promises);
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === x.filename)
      throw Object.assign(new Error(`private path ${x.root}`), {
        code: 'ENOSPC',
      });
    return rename(from, to);
  });
  const { snapshot, plan } = imported(x.root);
  assert.deepEqual(
    await custom.registerRestoredCustomGame(x.root, snapshot, plan),
    { status: 'failed', code: 'CUSTOM_GAME_REGISTRATION_FAILED' },
  );
  assert.equal(await fs.promises.readFile(x.filename, 'utf8'), original);
  assert.deepEqual(await fs.promises.readdir(x.root), ['custom_entries.json']);
});

test('concurrent full edits, reads and registrations share a file lock and see the latest entries', async (t) => {
  const x = await fixture(t);
  const local = definition();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const edit = custom.updateCustomEntries(x.root, async () => {
    entered();
    await held;
    return [local];
  });
  await ready;
  const first = imported(x.root);
  const second = imported(x.root);
  let readDone = false;
  const read = custom
    .readCustomEntries(path.join(x.root, '.'))
    .then((entries) => {
      readDone = true;
      return entries;
    });
  const registrations = [first, second, first].map((value) =>
    custom.registerRestoredCustomGame(x.root, value.snapshot, value.plan),
  );
  await nextTurn();
  assert.equal(readDone, false);
  release();
  await edit;
  assert.deepEqual(await read, [local]);
  assert.deepEqual(await Promise.all(registrations), [
    { status: 'registered' },
    { status: 'registered' },
    { status: 'existing' },
  ]);
  const entries = await custom.readCustomEntries(x.root);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], local);
});

test('an optimistic edit conflict leaves original bytes intact and releases the shared lock', async (t) => {
  const x = await fixture(t);
  const original = JSON.stringify([definition()]);
  await fs.promises.writeFile(x.filename, original);
  await assert.rejects(
    custom.updateCustomEntries(x.root, () => {
      throw Object.assign(new Error('conflict'), {
        code: 'CUSTOM_ENTRIES_CONFLICT',
      });
    }),
    { code: 'CUSTOM_ENTRIES_CONFLICT' },
  );
  assert.equal(await fs.promises.readFile(x.filename, 'utf8'), original);
  const value = imported(x.root);
  assert.deepEqual(
    await custom.registerRestoredCustomGame(x.root, value.snapshot, value.plan),
    { status: 'registered' },
  );
});

test('incomplete plans and mismatched remote custom identities are rejected before a write', async (t) => {
  const x = await fixture(t);
  const incomplete = imported(x.root, { types: ['folder', 'file'] });
  incomplete.plan.pop();
  assert.deepEqual(
    await custom.registerRestoredCustomGame(
      x.root,
      incomplete.snapshot,
      incomplete.plan,
    ),
    { status: 'failed', code: 'CUSTOM_GAME_INVALID' },
  );
  const mismatched = imported(x.root);
  mismatched.snapshot.metadata.customDefinition.wiki_page_id = randomUUID();
  assert.deepEqual(
    await custom.registerRestoredCustomGame(
      x.root,
      mismatched.snapshot,
      mismatched.plan,
    ),
    { status: 'failed', code: 'CUSTOM_GAME_INVALID' },
  );
  assert.equal(fs.existsSync(x.filename), false);
});

async function restoreFixture(t, { skip = false } = {}) {
  const x = await fixture(t);
  const backupRoot = path.join(x.root, 'backups');
  const candidate = imported(backupRoot);
  const identity = snapshots.newSnapshotIdentity();
  const source = path.join(
    backupRoot,
    candidate.snapshot.gameId,
    identity.folder,
    'path1',
  );
  await fs.promises.mkdir(source, { recursive: true });
  await fs.promises.writeFile(
    path.join(source, 'save.dat'),
    'restored content',
  );
  await snapshots.atomicWriteJson(path.join(source, '..', 'backup_info.json'), {
    ...candidate.snapshot.metadata,
    createdAt: identity.createdAt,
    snapshotId: identity.snapshotId,
  });
  const destination = path.join(x.root, 'chosen-save.dat');
  const state = { paused: 0, resumed: 0, protection: 0 };
  const overrides = {
    electron: { BrowserWindow: { getFocusedWindow: () => null }, dialog: {} },
    'original-fs': fs,
    i18next: { t: (key) => key },
    './global': {
      getSettings: () => ({ backupPath: backupRoot }),
      getGameDisplayName: (game) => game.title,
      getLatestModificationTime: async (target) =>
        new Date(skip && target === destination ? 1000 : 0),
      findGameInstallPath: () => null,
    },
    './gameData': {
      getAllAccountIds: () => ({}),
      resolvePlaceholder: () => null,
    },
    './registry': { registryKeyExists: () => false },
    './autoBackup': {
      pauseAutoBackupForRestore: async () => {
        state.paused++;
        return async () => {
          state.resumed++;
        };
      },
    },
    './backup': {
      createBackupSnapshot: async (game) => {
        state.protection++;
        assert.equal(game.resolved_paths[0].resolved, destination);
        return { snapshotId: randomUUID(), folder: 'protection' };
      },
    },
  };
  const filename = path.resolve(__dirname, '../src/main/backup/restore.js');
  const loaded = require('./helpers/load-main.cjs').createMainLoader(overrides)(
    'restore',
  );
  return {
    ...x,
    backupRoot,
    state,
    source,
    destination,
    restore: loaded.restoreSnapshot,
    request: {
      gameId: candidate.snapshot.gameId,
      folder: identity.folder,
      mappings: { path1: destination },
      userActionForAll: skip ? 'skip' : null,
    },
  };
}

test('successful mapped cloud restore registers a local entry and restores listener state', async (t) => {
  const x = await restoreFixture(t);
  assert.equal(
    fs.existsSync(path.join(x.backupRoot, 'custom_entries.json')),
    false,
  );
  const result = await x.restore(x.request);
  assert.equal(result.error, null);
  assert.deepEqual(result.customGameRegistration, { status: 'registered' });
  assert.equal(
    await fs.promises.readFile(x.destination, 'utf8'),
    'restored content',
  );
  const [entry] = await custom.readCustomEntries(x.backupRoot);
  const platform = { win32: 'win', linux: 'linux', darwin: 'mac' }[
    process.platform
  ];
  assert.deepEqual(entry.save_location[platform], [
    { template: x.destination, type: 'file' },
  ]);
  assert.deepEqual(x.state, { paused: 1, resumed: 1, protection: 1 });
});

test('custom registration failure remains secondary to a successful actual restore', async (t) => {
  const x = await restoreFixture(t);
  const filename = path.join(x.backupRoot, 'custom_entries.json');
  await fs.promises.writeFile(filename, 'broken original bytes');
  const result = await x.restore(x.request);
  assert.equal(result.error, null);
  assert.deepEqual(result.customGameRegistration, {
    status: 'failed',
    code: 'CUSTOM_ENTRIES_CORRUPT',
  });
  assert.equal(
    await fs.promises.readFile(x.destination, 'utf8'),
    'restored content',
  );
  assert.equal(
    await fs.promises.readFile(filename, 'utf8'),
    'broken original bytes',
  );
  assert.deepEqual(x.state, { paused: 1, resumed: 1, protection: 1 });
});

test('failed and skipped restores never register a custom entry', async (t) => {
  const x = await restoreFixture(t);
  const copyFile = fs.promises.copyFile.bind(fs.promises);
  t.mock.method(fs.promises, 'copyFile', async (from, to, mode) => {
    if (to === x.destination)
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return copyFile(from, to, mode);
  });
  const result = await x.restore(x.request);
  assert.equal(result.code, 'PARTIAL_RESTORE');
  assert.equal(result.pathResults[0].code, 'ENOSPC');
  assert.equal(result.customGameRegistration, undefined);
  assert.equal(
    fs.existsSync(path.join(x.backupRoot, 'custom_entries.json')),
    false,
  );
  const skipped = await restoreFixture(t, { skip: true });
  const skippedResult = await skipped.restore(skipped.request);
  assert.equal(skippedResult.code, 'SKIPPED');
  assert.equal(skippedResult.customGameRegistration, undefined);
  assert.equal(
    fs.existsSync(path.join(skipped.backupRoot, 'custom_entries.json')),
    false,
  );
  assert.deepEqual(skipped.state, { paused: 0, resumed: 0, protection: 0 });
});
