const test = require('node:test');
const assert = require('node:assert/strict');
const fs = (() => { try { return require('original-fs'); } catch { return require('node:fs'); } })();
const path = require('node:path');
const os = require('node:os');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { migrateBackupLibrary, validateMigrationPaths } = require('../src/main/backupMigration');
const { withGameLock, withLibraryLock, isLibraryBusy } = require('../src/main/backupCoordinator');

async function fixture(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gsm-migration-test-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    await fs.promises.mkdir(path.join(source, '123', 'snapshot', 'empty'), { recursive: true });
    await fs.promises.writeFile(path.join(source, '123', 'snapshot', 'a.dat'), 'aaaa');
    await fs.promises.writeFile(path.join(source, '123', 'snapshot', 'b.dat'), 'bbbb');
    await fs.promises.writeFile(path.join(source, 'custom_entries.json'), '[{"title":"Game"}]');
    return { root, source, destination };
}

async function contents(root) {
    const result = {};
    async function walk(current, relative = '') {
        for (const name of (await fs.promises.readdir(current)).sort()) {
            const absolute = path.join(current, name);
            const key = relative ? `${relative}/${name}` : name;
            if ((await fs.promises.stat(absolute)).isDirectory()) { result[`${key}/`] = null; await walk(absolute, key); }
            else result[key] = await fs.promises.readFile(absolute, 'utf8');
        }
    }
    await walk(root);
    return result;
}

test('migration validates absolute, distinct, non-overlapping roots', async t => {
    const x = await fixture(t);
    for (const target of [x.source, path.join(x.source, 'nested'), x.root]) assert.throws(() => validateMigrationPaths(x.source, target), { code: 'OVERLAPPING_MIGRATION_PATHS' });
    assert.throws(() => validateMigrationPaths('relative', x.destination), { code: 'INVALID_MIGRATION_PATH' });
});

test('verified migration commits sibling staging before activation and retains original library', async t => {
    const x = await fixture(t);
    await fs.promises.mkdir(x.destination);
    const original = await contents(x.source);
    let activated = false;
    const result = await migrateBackupLibrary(x.source, x.destination, { activate: async destination => {
        assert.equal(destination, x.destination);
        assert.equal(isLibraryBusy(), true);
        assert.deepEqual(await contents(destination), original);
        activated = true;
        return true;
    } });
    assert.equal(activated, true);
    assert.equal(result.sourceRetained, true);
    assert.equal(result.fileCount, 3);
    assert.deepEqual(await contents(x.source), original);
    assert.deepEqual(await contents(x.destination), original);
    assert.equal((await fs.promises.readdir(x.root)).some(name => name.startsWith('.gsm-migrate-')), false);
    assert.equal(isLibraryBusy(), false);
});

test('copy failure preserves the complete source and does not activate the target', async t => {
    const x = await fixture(t);
    const original = await contents(x.source);
    const copy = fs.promises.copyFile.bind(fs.promises);
    t.mock.method(fs.promises, 'copyFile', async (source, destination, flags) => {
        if (path.basename(source) === 'b.dat') throw Object.assign(new Error('injected copy error'), { code: 'EIO' });
        return copy(source, destination, flags);
    });
    await assert.rejects(migrateBackupLibrary(x.source, x.destination, { activate: async () => assert.fail('must not activate') }), { code: 'EIO' });
    assert.deepEqual(await contents(x.source), original);
    assert.equal(fs.existsSync(x.destination), false);
    assert.deepEqual(await fs.promises.readdir(x.root), ['source']);
});

test('same-size copy corruption fails SHA-256 verification without modifying original data', async t => {
    const x = await fixture(t);
    const original = await contents(x.source);
    const copy = fs.promises.copyFile.bind(fs.promises);
    t.mock.method(fs.promises, 'copyFile', async (source, destination, flags) => {
        await copy(source, destination, flags);
        if (path.basename(source) === 'b.dat') await fs.promises.writeFile(destination, 'xxxx');
    });
    await assert.rejects(migrateBackupLibrary(x.source, x.destination, { activate: async () => assert.fail('must not activate') }), { code: 'MIGRATION_VERIFICATION_FAILED' });
    assert.deepEqual(await contents(x.source), original);
    assert.equal(fs.existsSync(x.destination), false);
    assert.deepEqual(await fs.promises.readdir(x.root), ['source']);
});

test('pre-existing destination files are never merged or overwritten', async t => {
    const x = await fixture(t);
    await fs.promises.mkdir(x.destination);
    await fs.promises.writeFile(path.join(x.destination, 'keep.dat'), 'keep');
    const original = await contents(x.source);
    await assert.rejects(migrateBackupLibrary(x.source, x.destination, { activate: async () => assert.fail('must not activate') }), { code: 'MIGRATION_TARGET_CONFLICT' });
    assert.deepEqual(await contents(x.source), original);
    assert.equal(await fs.promises.readFile(path.join(x.destination, 'keep.dat'), 'utf8'), 'keep');
});

test('destination populated during copying fails the final conflict check safely', async t => {
    const x = await fixture(t);
    const original = await contents(x.source);
    let populated = false;
    await assert.rejects(migrateBackupLibrary(x.source, x.destination, {
        activate: async () => assert.fail('must not activate'),
        onProgress: event => {
            if (!populated && event.stage === 'verifying') {
                populated = true;
                fs.mkdirSync(x.destination);
                fs.writeFileSync(path.join(x.destination, 'keep.dat'), 'keep');
            }
        },
    }), { code: 'MIGRATION_TARGET_CONFLICT' });
    assert.deepEqual(await contents(x.source), original);
    assert.equal(await fs.promises.readFile(path.join(x.destination, 'keep.dat'), 'utf8'), 'keep');
});

test('settings activation failure retains both original and verified new copy', async t => {
    const x = await fixture(t);
    const original = await contents(x.source);
    await assert.rejects(migrateBackupLibrary(x.source, x.destination, { activate: async () => false }), error => error.code === 'MIGRATION_SETTINGS_FAILED' && error.destinationCommitted === true);
    assert.deepEqual(await contents(x.source), original);
    assert.deepEqual(await contents(x.destination), original);
    assert.equal(isLibraryBusy(), false);
});

test('global migration restores the in-memory backup path when settings persistence fails', async t => {
    const x = await fixture(t);
    const filename = path.resolve(__dirname, '../src/main/global.js');
    const text = await fs.promises.readFile(filename, 'utf8');
    const start = text.indexOf('async function moveFilesWithProgress(');
    const end = text.indexOf('module.exports =', start);
    const settings = { backupPath: x.source };
    const status = { migrating: false };
    const factory = new Function('require', 'i18next', 'win', 'status', 'settings', 'saveSettings', 'coordinator', `return (${text.slice(start, end).trim()});`);
    const migrate = factory(
        name => { assert.equal(name, './backupMigration'); return { migrateBackupLibrary }; },
        { t: (key, options) => options?.defaultValue || key },
        { isDestroyed: () => false, webContents: { send() {} } }, status, settings,
        async (_key, destination) => { settings.backupPath = destination; return null; },
        { isLibraryBusy },
    );
    const result = await migrate(x.source, x.destination);
    assert.equal(result.success, false);
    assert.equal(result.code, 'MIGRATION_SETTINGS_FAILED');
    assert.equal(settings.backupPath, x.source);
    assert.equal(status.migrating, false);
    assert.deepEqual(await contents(x.destination), await contents(x.source));
});

test('failed final rename restores an initially empty destination and leaves source untouched', async t => {
    const x = await fixture(t);
    await fs.promises.mkdir(x.destination);
    const original = await contents(x.source);
    const rename = fs.promises.rename.bind(fs.promises);
    t.mock.method(fs.promises, 'rename', async (source, destination) => {
        if (path.basename(source).startsWith('.gsm-migrate-')) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
        return rename(source, destination);
    });
    await assert.rejects(migrateBackupLibrary(x.source, x.destination, { activate: async () => assert.fail('must not activate') }), { code: 'EPERM' });
    assert.deepEqual(await contents(x.source), original);
    assert.deepEqual(await fs.promises.readdir(x.destination), []);
    assert.equal((await fs.promises.readdir(x.root)).some(name => name.startsWith('.gsm-migrate-')), false);
});

test('source additions during migration abort before switching the configured library', async t => {
    const x = await fixture(t);
    let added = false;
    await assert.rejects(migrateBackupLibrary(x.source, x.destination, {
        activate: async () => assert.fail('must not activate'),
        onProgress: event => {
            if (!added && event.stage === 'verifying') {
                added = true;
                fs.writeFileSync(path.join(x.source, 'new-file.dat'), 'new data');
            }
        },
    }), { code: 'MIGRATION_SOURCE_CHANGED' });
    assert.equal(await fs.promises.readFile(path.join(x.source, 'new-file.dat'), 'utf8'), 'new data');
    assert.equal(await fs.promises.readFile(path.join(x.source, '123', 'snapshot', 'a.dat'), 'utf8'), 'aaaa');
    assert.equal(fs.existsSync(x.destination), false);
});

test('migration drains queued game operations and lets subsequent games continue without deadlock', { timeout: 3000 }, async () => {
    const events = [];
    let finishFirst, finishMigration;
    const firstGate = new Promise(resolve => { finishFirst = resolve; });
    const migrationGate = new Promise(resolve => { finishMigration = resolve; });
    const first = withGameLock('234', async () => { events.push('first'); await firstGate; });
    const queued = withGameLock('234', async () => { events.push('queued'); });
    await nextTurn();
    const migration = withLibraryLock(async () => { events.push('migration'); await migrationGate; });
    assert.equal(isLibraryBusy(), true);
    const later = withGameLock('234', async () => events.push('later'));
    const other = withGameLock('235', async () => events.push('other'));
    await nextTurn();
    assert.deepEqual(events, ['first']);
    finishFirst();
    await Promise.all([first, queued]);
    await nextTurn();
    assert.deepEqual(events, ['first', 'queued', 'migration']);
    finishMigration();
    await Promise.all([migration, later, other]);
    assert.deepEqual(events, ['first', 'queued', 'migration', 'later', 'other']);
    assert.equal(isLibraryBusy(), false);
});

test('failed exclusive operations release the gate and preserve writer ordering', { timeout: 3000 }, async () => {
    const events = [];
    const first = withLibraryLock(async () => { events.push('first'); throw new Error('injected'); });
    const second = withLibraryLock(async () => events.push('second'));
    const game = withGameLock('236', async () => events.push('game'));
    await assert.rejects(first, /injected/);
    await Promise.all([second, game]);
    assert.deepEqual(events, ['first', 'second', 'game']);
    assert.equal(isLibraryBusy(), false);
});
