const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/main/backup/snapshotStore');
const coordinator = require('../src/main/backup/backupCoordinator');

async function setup(
  t,
  {
    realRegistry = false,
    globalOverrides = {},
    snapshotStoreOverride = store,
  } = {},
) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'gsm-restore-test-'),
  );
  t.after(async () => {
    coordinator.setCommitHook(null);
    coordinator.setIntentProvider(null);
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  const backupRoot = path.join(root, 'backups');
  const save = path.join(root, 'save.dat');
  await fs.promises.writeFile(save, 'original');
  const state = { paused: 0, resumed: 0 };
  const settings = { backupPath: backupRoot, maxBackups: 10 };
  const globalMock = {
    getSettings: () => settings,
    getGameDisplayName: (game) => game.title || 'Game',
    readJsonFile: async (file) =>
      JSON.parse(await fs.promises.readFile(file, 'utf8')),
    writeJsonFile: async (file, value) =>
      fs.promises.writeFile(file, JSON.stringify(value)),
    getLatestModificationTime: async () => new Date(0),
    findGameInstallPath: () => null,
    ...globalOverrides,
  };
  const overrides = {
    electron: {
      app: { getPath: () => root },
      BrowserWindow: { getFocusedWindow: () => null },
      dialog: {},
    },
    'original-fs': fs,
    axios: {},
    'fs-extra': {},
    glob: {},
    sqlite3: {},
    i18next: { t: (key) => key },
    './global': globalMock,
    './snapshotStore': snapshotStoreOverride,
    './backupCoordinator': coordinator,
    './gameData': {
      getAllAccountIds: () => ({ steamAccountId: '111' }),
      resolvePlaceholder: (token) =>
        token === '{{p|hkcu}}' ? 'HKEY_CURRENT_USER' : null,
    },
    './registry': realRegistry
      ? require('../src/main/platform/registry')
      : { registryKeyExists: () => false },
    './autoBackup': {
      pauseAutoBackupForRestore: async () => {
        state.paused++;
        return async () => {
          state.resumed++;
        };
      },
    },
  };
  const load = require('./helpers/load-main.cjs').createMainLoader(overrides);
  const backup = load('backup');
  overrides['./backup'] = backup;
  const restore = load('restore');
  const game = {
    wiki_page_id: '98765',
    title: 'Game',
    resolved_paths: [{ resolved: save, finalTemplate: save, type: 'file' }],
  };
  return {
    root,
    backupRoot,
    save,
    backup,
    restore,
    game,
    state,
    overrides,
    settings,
  };
}

test('backup failure never exposes partial snapshot or rotates committed saves', async (t) => {
  const x = await setup(t);
  assert.equal(await x.backup.backupGame(x.game), null);
  const initial = await store.listSnapshots(x.backupRoot);
  const error = await x.backup.backupGame({
    ...x.game,
    resolved_paths: [
      ...x.game.resolved_paths,
      {
        resolved: path.join(x.root, 'missing'),
        finalTemplate: 'missing',
        type: 'file',
      },
    ],
  });
  assert.ok(error);
  const snapshots = await store.listSnapshots(x.backupRoot);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].snapshotId, initial[0].snapshotId);
  assert.equal(
    (
      await fs.promises.readdir(path.join(x.backupRoot, x.game.wiki_page_id))
    ).some((name) => name.startsWith('.pending')),
    false,
  );
});

test('cloud enqueue failure preserves local success and committed upload intent', async (t) => {
  const x = await setup(t);
  coordinator.setIntentProvider(() => ({ targetId: 'target', revision: 3 }));
  coordinator.setCommitHook(async () => {
    throw new Error('offline');
  });
  assert.equal(await x.backup.backupGame(x.game), null);
  assert.equal(
    (await store.listSnapshots(x.backupRoot))[0].metadata.cloudUploadIntent
      .targetId,
    'target',
  );
});

test('legacy backup size discovery preserves concurrent snapshot identity and label updates', async (t) => {
  let releaseIdentity;
  const identityHeld = new Promise((resolve) => {
    releaseIdentity = resolve;
  });
  let identityRead;
  const identityReady = new Promise((resolve) => {
    identityRead = resolve;
  });
  let selected, identityUpdate;
  const snapshotId = require('node:crypto').randomUUID();
  const originDeviceId = require('node:crypto').randomUUID();
  const x = await setup(t, {
    globalOverrides: {
      calculateDirectorySize: async () => {
        identityUpdate = store.updateMetadata(selected, async (metadata) => {
          identityRead();
          await identityHeld;
          return {
            ...metadata,
            snapshotId,
            originDeviceId,
            custom_name: 'Keep this checkpoint',
          };
        });
        await identityReady;
        return 4321;
      },
      // The former independent writer reads stale metadata while the identity update owns its lock.
      readJsonFile: async (file) => {
        const metadata = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        releaseIdentity();
        await identityUpdate;
        return metadata;
      },
    },
    snapshotStoreOverride: {
      ...store,
      updateMetadata: (...args) => {
        // Let the owner finish once discovery queues its own metadata update.
        releaseIdentity();
        return store.updateMetadata(...args);
      },
    },
  });
  const folder = '2024-01-02_03-04';
  const directory = path.join(x.backupRoot, x.game.wiki_page_id, folder);
  await fs.promises.mkdir(path.join(directory, 'path1'), { recursive: true });
  await fs.promises.writeFile(
    path.join(directory, 'path1', 'save.dat'),
    'checkpoint',
  );
  await fs.promises.writeFile(
    path.join(directory, 'backup_info.json'),
    JSON.stringify({
      title: 'Game',
      backup_paths: [{ folder_name: 'path1', template: x.save, type: 'file' }],
    }),
  );
  selected = await store.readSnapshot(
    x.backupRoot,
    x.game.wiki_page_id,
    folder,
  );
  const listed = await x.restore.getGameDataForRestore(
    x.game.wiki_page_id,
    true,
  );
  await identityUpdate;
  assert.deepEqual(listed.errors, []);
  assert.equal(listed.games[0].backups[0].backup_size, 4321);
  const saved = await store.readSnapshot(
    x.backupRoot,
    x.game.wiki_page_id,
    folder,
  );
  assert.equal(saved.snapshotId, snapshotId);
  assert.equal(saved.metadata.originDeviceId, originDeviceId);
  assert.equal(saved.metadata.custom_name, 'Keep this checkpoint');
  assert.equal(saved.metadata.backup_size, 4321);
});

test('restore selects the requested disk snapshot and protects actual mapped destination', async (t) => {
  const x = await setup(t);
  await x.backup.backupGame(x.game);
  const selected = (await store.listSnapshots(x.backupRoot))[0];
  await fs.promises.writeFile(x.save, 'newer progress');
  await x.backup.backupGame(x.game);
  const mapped = path.join(x.root, 'different-name.dat');
  await fs.promises.writeFile(mapped, 'mapped progress');
  const result = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: selected.folder,
    mappings: { path1: mapped },
  });
  assert.equal(result.error, null);
  assert.equal(await fs.promises.readFile(mapped, 'utf8'), 'original');
  assert.equal(await fs.promises.readFile(x.save, 'utf8'), 'newer progress');
  const protection = await store.readSnapshot(
    x.backupRoot,
    x.game.wiki_page_id,
    result.protectionFolder,
  );
  assert.equal(protection.metadata.restoreProtection, true);
  assert.equal(protection.metadata.is_permanent, true);
  assert.equal(protection.metadata.backup_paths[0].template, mapped);
  assert.equal(
    await fs.promises.readFile(
      path.join(protection.path, 'path1', 'different-name.dat'),
      'utf8',
    ),
    'mapped progress',
  );
  assert.deepEqual(x.state, { paused: 1, resumed: 1 });
});

test('complete preflight failure leaves every destination untouched', async (t) => {
  const x = await setup(t);
  await x.backup.backupGame(x.game);
  let selected = (await store.listSnapshots(x.backupRoot))[0];
  selected = await store.updateMetadata(selected, (metadata) => ({
    ...metadata,
    backup_paths: [
      ...metadata.backup_paths,
      {
        folder_name: 'path2',
        template: path.join(x.root, 'unknown.dat'),
        type: 'file',
      },
    ],
  }));
  await fs.promises.writeFile(x.save, 'keep me');
  const result = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: selected.folder,
  });
  assert.ok(result.error);
  assert.equal(await fs.promises.readFile(x.save, 'utf8'), 'keep me');
  assert.deepEqual(x.state, { paused: 0, resumed: 0 });
});

test('failed protection backup aborts restore and always resumes monitoring', async (t) => {
  const x = await setup(t);
  await x.backup.backupGame(x.game);
  const selected = (await store.listSnapshots(x.backupRoot))[0];
  await fs.promises.writeFile(x.save, 'keep me');
  x.overrides['./backup'] = {
    createBackupSnapshot: async () => {
      throw new Error('disk full');
    },
  };
  const result = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: selected.folder,
  });
  assert.match(result.error, /disk full/);
  assert.equal(await fs.promises.readFile(x.save, 'utf8'), 'keep me');
  assert.deepEqual(x.state, { paused: 1, resumed: 1 });
  assert.equal(coordinator.isProtected(selected.path), false);
});

test('cloud absolute paths require mapping and renderer-supplied paths are ignored', async (t) => {
  const x = await setup(t);
  await x.backup.backupGame(x.game);
  let selected = (await store.listSnapshots(x.backupRoot))[0];
  selected = await store.updateMetadata(selected, (metadata) => ({
    ...metadata,
    cloudImported: true,
  }));
  const result = await x.restore.restoreGame({
    ...x.game,
    backups: [{ date: selected.folder, backup_paths: [{ template: x.save }] }],
  });
  assert.equal(result.code, 'PATH_MAPPING_REQUIRED');
  assert.equal(result.mappingsRequired[0].folder, 'path1');
  assert.deepEqual(x.state, { paused: 0, resumed: 0 });
});

test('cloud placeholder templates also require user-selected targets before touching local files', async (t) => {
  const x = await setup(t);
  await x.backup.backupGame(x.game);
  let selected = (await store.listSnapshots(x.backupRoot))[0];
  selected = await store.updateMetadata(selected, (metadata) => ({
    ...metadata,
    cloudImported: true,
    backup_paths: metadata.backup_paths.map((entry) => ({
      ...entry,
      template: '{{p|appdata}}\\UnrelatedApplication\\settings.dat',
    })),
  }));
  const result = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: selected.folder,
  });
  assert.equal(result.code, 'PATH_MAPPING_REQUIRED');
  assert.equal(result.mappingsRequired[0].folder, 'path1');
  assert.deepEqual(x.state, { paused: 0, resumed: 0 });
  assert.equal(await fs.promises.readFile(x.save, 'utf8'), 'original');
});

test('custom game registry imports request key confirmation instead of an impossible file mapping', async (t) => {
  const x = await setup(t);
  const game = {
    ...x.game,
    wiki_page_id: 'd8674e99-56d9-46c3-a843-aa50733119e1',
  };
  await x.backup.backupGame(game);
  let selected = (await store.listSnapshots(x.backupRoot))[0];
  selected = await store.updateMetadata(selected, (metadata) => ({
    ...metadata,
    cloudImported: true,
    backup_paths: [
      {
        folder_name: 'path1',
        type: 'reg',
        template: 'HKEY_CURRENT_USER\\Software\\GSMTestGame',
      },
    ],
  }));
  const result = await x.restore.restoreSnapshot({
    gameId: game.wiki_page_id,
    folder: selected.folder,
  });
  assert.equal(result.code, 'REGISTRY_CONFIRMATION_REQUIRED');
  assert.equal(
    result.registryTargets[0].key,
    'HKEY_CURRENT_USER\\Software\\GSMTestGame',
  );
  assert.deepEqual(x.state, { paused: 0, resumed: 0 });
});

test('registry validation refuses undeclared keys before any reg.exe execution', async (t) => {
  const x = await setup(t);
  const malicious = Buffer.from(
    'Windows Registry Editor Version 5.00\n\n[HKEY_CURRENT_USER\\Software\\Other]\n"x"="y"\n',
  );
  assert.throws(
    () =>
      x.restore.checkRegistryContent(
        malicious,
        'HKEY_CURRENT_USER\\Software\\Game',
        'HKEY_CURRENT_USER\\Software\\Game',
      ),
    /outside/,
  );
  const malformed = Buffer.from(
    'Windows Registry Editor Version 5.00\n\n[HKEY_CURRENT_USER\\Software\\Game]\n[HKEY_CURRENT_USER\\Software\\Other] trailing text\n',
  );
  assert.throws(
    () =>
      x.restore.checkRegistryContent(
        malformed,
        'HKEY_CURRENT_USER\\Software\\Game',
        'HKEY_CURRENT_USER\\Software\\Game',
      ),
    /invalid key section/,
  );
});

test(
  'Windows registry backup, protected restore and missing-key rollback use an isolated game key',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const x = await setup(t, { realRegistry: true });
    const { execFile } = require('node:child_process');
    const run = require('node:util').promisify(execFile);
    const registry = require('../src/main/platform/registry');
    const key = `HKEY_CURRENT_USER\\Software\\GSMCloudValidation_${require('node:crypto').randomUUID()}`;
    assert.match(
      key,
      /^HKEY_CURRENT_USER\\Software\\GSMCloudValidation_[a-f0-9-]{36}$/,
    );
    assert.equal(registry.registryKeyExists(key), false);
    t.after(async () => {
      if (registry.registryKeyExists(key))
        await run('reg.exe', ['delete', key, '/f'], { windowsHide: true });
    });
    const write = (value) =>
      run(
        'reg.exe',
        ['add', key, '/v', 'Progress', '/t', 'REG_SZ', '/d', value, '/f'],
        { windowsHide: true },
      );
    await write('saved checkpoint');
    const game = {
      ...x.game,
      resolved_paths: [
        {
          resolved: key,
          finalTemplate: key
            .replace('HKEY_CURRENT_USER', '{{p|hkcu}}')
            .replace(/\\/g, '/'),
          type: 'reg',
        },
      ],
    };
    assert.equal(await x.backup.backupGame(game), null);
    const selected = (await store.listSnapshots(x.backupRoot))[0];
    await write('current checkpoint');
    const restored = await x.restore.restoreSnapshot({
      gameId: game.wiki_page_id,
      folder: selected.folder,
    });
    assert.equal(restored.error, null);
    assert.equal(
      registry.getRegistryValue(key, 'Progress'),
      'saved checkpoint',
    );
    const rollback = await x.restore.restoreSnapshot({
      gameId: game.wiki_page_id,
      folder: restored.protectionFolder,
    });
    assert.equal(rollback.error, null);
    assert.equal(
      registry.getRegistryValue(key, 'Progress'),
      'current checkpoint',
    );
    await run('reg.exe', ['delete', key, '/f'], { windowsHide: true });
    const recreated = await x.restore.restoreSnapshot({
      gameId: game.wiki_page_id,
      folder: selected.folder,
    });
    assert.equal(recreated.error, null);
    assert.equal(
      registry.getRegistryValue(key, 'Progress'),
      'saved checkpoint',
    );
    const missingRollback = await x.restore.restoreSnapshot({
      gameId: game.wiki_page_id,
      folder: recreated.protectionFolder,
    });
    assert.equal(missingRollback.error, null);
    assert.equal(registry.registryKeyExists(key), false);
  },
);

test('folder restore replaces all content and protection rollback removes later additions', async (t) => {
  const x = await setup(t);
  const target = path.join(x.root, 'game-folder');
  await fs.promises.mkdir(target);
  await fs.promises.writeFile(path.join(target, 'save.dat'), 'old');
  const game = {
    ...x.game,
    resolved_paths: [
      { resolved: target, finalTemplate: target, type: 'folder' },
    ],
  };
  await x.backup.backupGame(game);
  const selected = (await store.listSnapshots(x.backupRoot))[0];
  await fs.promises.writeFile(path.join(target, 'save.dat'), 'current');
  await fs.promises.writeFile(path.join(target, 'extra.dat'), 'current extra');
  const restored = await x.restore.restoreSnapshot({
    gameId: game.wiki_page_id,
    folder: selected.folder,
  });
  assert.equal(restored.error, null);
  assert.deepEqual(await fs.promises.readdir(target), ['save.dat']);
  assert.equal(
    await fs.promises.readFile(path.join(target, 'save.dat'), 'utf8'),
    'old',
  );
  await fs.promises.writeFile(path.join(target, 'later.dat'), 'later');
  const rolledBack = await x.restore.restoreSnapshot({
    gameId: game.wiki_page_id,
    folder: restored.protectionFolder,
  });
  assert.equal(rolledBack.error, null);
  assert.deepEqual((await fs.promises.readdir(target)).sort(), [
    'extra.dat',
    'save.dat',
  ]);
  assert.equal(
    await fs.promises.readFile(path.join(target, 'save.dat'), 'utf8'),
    'current',
  );
});

test('protection backup records absent targets and restores their absence', async (t) => {
  const x = await setup(t);
  await x.backup.backupGame(x.game);
  const selected = (await store.listSnapshots(x.backupRoot))[0];
  await fs.promises.unlink(x.save);
  const result = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: selected.folder,
  });
  assert.equal(result.error, null);
  assert.equal(fs.existsSync(x.save), true);
  const protection = await store.readSnapshot(
    x.backupRoot,
    x.game.wiki_page_id,
    result.protectionFolder,
  );
  assert.equal(protection.metadata.backup_paths[0].originalMissing, true);
  const rollback = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: result.protectionFolder,
  });
  assert.equal(rollback.error, null);
  assert.equal(fs.existsSync(x.save), false);
});

test('failed folder swap restores the previous directory', async (t) => {
  const x = await setup(t);
  const source = path.join(x.root, 'snapshot-folder');
  const destination = path.join(x.root, 'destination-folder');
  await fs.promises.mkdir(source);
  await fs.promises.mkdir(destination);
  await fs.promises.writeFile(path.join(source, 'new.dat'), 'new');
  await fs.promises.writeFile(path.join(destination, 'old.dat'), 'old');
  const rename = fs.promises.rename.bind(fs.promises);
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (path.basename(from).startsWith('.gsm-restore-new-'))
      throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    return rename(from, to);
  });
  await assert.rejects(
    x.restore.replaceDirectory(source, destination),
    /sharing violation/,
  );
  assert.equal(
    await fs.promises.readFile(path.join(destination, 'old.dat'), 'utf8'),
    'old',
  );
  assert.deepEqual(
    (await fs.promises.readdir(x.root)).filter((name) =>
      name.startsWith('.gsm-restore'),
    ),
    [],
  );
});

test('nested file and directory saves restore parent first and roll back all current contents', async (t) => {
  const x = await setup(t);
  const parent = path.join(x.root, 'nested'),
    child = path.join(parent, 'child'),
    file = path.join(child, 'save.dat');
  await fs.promises.mkdir(child, { recursive: true });
  await fs.promises.writeFile(file, 'old');
  const game = {
    ...x.game,
    resolved_paths: [
      { resolved: file, type: 'file' },
      { resolved: child, type: 'folder' },
      { resolved: parent, type: 'folder' },
    ].map((entry) => ({ ...entry, finalTemplate: entry.resolved })),
  };
  await x.backup.backupGame(game);
  const selected = (await store.listSnapshots(x.backupRoot))[0];
  // An explicitly backed up child takes precedence over its enclosing copy.
  await fs.promises.writeFile(
    path.join(selected.path, 'path1', 'save.dat'),
    'child checkpoint',
  );
  await fs.promises.writeFile(file, 'current');
  await fs.promises.writeFile(path.join(parent, 'extra.dat'), 'current extra');
  const result = await x.restore.restoreSnapshot({
    gameId: game.wiki_page_id,
    folder: selected.folder,
  });
  assert.equal(result.error, null);
  assert.deepEqual(
    result.pathResults.map((item) => item.folder),
    ['path3', 'path2', 'path1'],
  );
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'child checkpoint');
  assert.equal(fs.existsSync(path.join(parent, 'extra.dat')), false);
  const rollback = await x.restore.restoreSnapshot({
    gameId: game.wiki_page_id,
    folder: result.protectionFolder,
  });
  assert.equal(rollback.error, null);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'current');
  assert.equal(
    await fs.promises.readFile(path.join(parent, 'extra.dat'), 'utf8'),
    'current extra',
  );
});

test('identical mapped destinations still fail before protection or writes', async (t) => {
  const x = await setup(t);
  const game = {
    ...x.game,
    resolved_paths: [...x.game.resolved_paths, ...x.game.resolved_paths],
  };
  await x.backup.backupGame(game);
  const selected = (await store.listSnapshots(x.backupRoot))[0];
  const result = await x.restore.restoreSnapshot({
    gameId: game.wiki_page_id,
    folder: selected.folder,
  });
  assert.equal(result.code, 'OVERLAPPING_DESTINATIONS');
  assert.deepEqual(x.state, { paused: 0, resumed: 0 });
});

test('exported missing-target protection snapshots import fully and require mapping before rollback', async (t) => {
  const x = await setup(t),
    archive = require('../src/main/backup/archive');
  await x.backup.backupGame(x.game);
  const selected = (await store.listSnapshots(x.backupRoot))[0];
  await fs.promises.unlink(x.save);
  const result = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: selected.folder,
  });
  assert.equal(result.error, null);
  const exported = path.join(x.root, 'export.gsmr'),
    extracted = path.join(x.root, 'extracted');
  await archive.createArchive(x.backupRoot, [x.game.wiki_page_id], exported);
  await archive.extractArchive(exported, extracted);
  const importedRoot = path.join(x.root, 'imported');
  const exportedSnapshots = await store.listSnapshots(extracted);
  assert.equal(exportedSnapshots.length, 2);
  for (const snapshot of exportedSnapshots)
    await store.importSnapshot(importedRoot, snapshot.path, {
      ...snapshot.metadata,
      gameId: snapshot.gameId,
    });
  assert.equal((await store.listSnapshots(importedRoot)).length, 2);
  x.settings.backupPath = importedRoot;
  const protection = (await store.listSnapshots(importedRoot)).find(
    (item) => item.metadata.restoreProtection,
  );
  const unconfirmed = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: protection.folder,
  });
  assert.equal(unconfirmed.code, 'PATH_MAPPING_REQUIRED');
  assert.equal(unconfirmed.mappingsRequired[0].originalMissing, true);
  assert.equal(fs.existsSync(x.save), true);
  const rollback = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: protection.folder,
    mappings: { path1: x.save },
  });
  assert.equal(rollback.error, null);
  assert.equal(fs.existsSync(x.save), false);
  const undo = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: rollback.protectionFolder,
  });
  assert.equal(undo.error, null);
  assert.equal(await fs.promises.readFile(x.save, 'utf8'), 'original');
  const stagedProtection = exportedSnapshots.find(
    (item) => item.metadata.restoreProtection,
  );
  await assert.rejects(
    store.importSnapshot(importedRoot, stagedProtection.path, {
      ...stagedProtection.metadata,
      restoreProtection: false,
      gameId: x.game.wiki_page_id,
    }),
    /protection snapshot/,
  );
  await fs.promises.writeFile(
    path.join(stagedProtection.path, 'path1', 'unexpected.dat'),
    'payload',
  );
  await assert.rejects(
    store.importSnapshot(importedRoot, stagedProtection.path, {
      ...stagedProtection.metadata,
      gameId: x.game.wiki_page_id,
    }),
    /must not contain payloads/,
  );
});

test('registry placeholder confirmation names concrete keys and validates the resolved source before remapping', async (t) => {
  const x = await setup(t);
  await x.backup.backupGame(x.game);
  let snapshot = (await store.listSnapshots(x.backupRoot))[0];
  snapshot = await store.updateMetadata(snapshot, (metadata) => ({
    ...metadata,
    cloudImported: true,
    backup_paths: [
      {
        folder_name: 'path1',
        type: 'reg',
        template: '{{p|hkcu}}/Software/GSMTestGame',
      },
    ],
  }));
  await fs.promises.writeFile(
    path.join(snapshot.path, 'path1', 'registry_backup.reg'),
    'Windows Registry Editor Version 5.00\n\n[HKEY_CURRENT_USER\\Software\\GSMTestGame]\n"Progress"="one"\n',
  );
  const confirmation = await x.restore.restoreSnapshot({
    gameId: x.game.wiki_page_id,
    folder: snapshot.folder,
  });
  assert.equal(confirmation.code, 'REGISTRY_CONFIRMATION_REQUIRED');
  assert.equal(
    confirmation.registryTargets[0].key,
    'HKEY_CURRENT_USER\\Software\\GSMTestGame',
  );
  const plan = await x.restore.preflightRestore(snapshot, {
    confirmRegistry: true,
    mappings: { path1: 'HKEY_CURRENT_USER\\Software\\GSMTestOther' },
  });
  assert.match(
    plan[0].registryContent.toString('utf16le'),
    /\[HKEY_CURRENT_USER\\Software\\GSMTestOther\]/,
  );
  await fs.promises.writeFile(
    path.join(snapshot.path, 'path1', 'registry_backup.reg'),
    'Windows Registry Editor Version 5.00\n\n[HKEY_CURRENT_USER\\Software\\Undeclared]\n',
  );
  await assert.rejects(
    x.restore.preflightRestore(snapshot, { confirmRegistry: true }),
    { code: 'INVALID_REGISTRY' },
  );
});
