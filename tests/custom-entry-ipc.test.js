const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const customGameStore = require('../src/main/customGameStore');
const backupCoordinator = require('../src/main/backupCoordinator');

async function harness(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-custom-ipc-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const handlers = new Map(), messages = [];
    const settings = { backupPath: root };
    const source = await fs.readFile(path.join(__dirname, '../src/main/main.js'), 'utf8');
    const start = source.indexOf("ipcMain.handle('save-custom-entries'");
    const end = source.indexOf("ipcMain.handle('get-account-data'", start);
    assert.ok(start > 0 && end > start);
    vm.runInNewContext(source.slice(start, end), {
        ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
        customGameStore, backupCoordinator, customEntryBaselines: new WeakMap(),
        getSettings: () => settings,
        getMainWin: () => ({ webContents: { send: (...args) => messages.push(args) } }),
        i18next: { t: key => key }, console: { error() {} },
    });
    const event = { sender: {} };
    return { root, settings, messages, load: () => handlers.get('load-custom-entries')(event), save: value => handlers.get('save-custom-entries')(event, value) };
}

const entry = title => ({ wiki_page_id: randomUUID(), title, save_location: { win: [{ template: 'C:\\Game\\save.dat', type: 'file' }] } });

test('custom editor rejects a stale full-list save after another operation registers a game', async t => {
    const x = await harness(t), first = entry('same title'), imported = entry('same title');
    await customGameStore.updateCustomEntries(x.root, () => [first]);
    assert.equal((await x.load()).length, 1);
    await customGameStore.updateCustomEntries(x.root, entries => [...entries, imported]);
    assert.equal(await x.save([{ ...first, title: 'unsaved edit' }]), false);
    assert.deepEqual(await customGameStore.readCustomEntries(x.root), [first, imported]);
    assert.ok(x.messages.some(message => message.includes('alert.custom_entries_changed')));
    const latest = await x.load();
    latest[0].title = 'saved edit';
    assert.equal(await x.save(latest), true);
    assert.equal((await customGameStore.readCustomEntries(x.root))[0].title, 'saved edit');
    await fs.writeFile(path.join(x.root, 'custom_entries.json'), 'broken original');
    await x.load();
    assert.equal(await x.save(latest), false);
    assert.equal(await fs.readFile(path.join(x.root, 'custom_entries.json'), 'utf8'), 'broken original');
});

test('custom editor waits for a library switch and reads the activated root', async t => {
    const x = await harness(t), nextRoot = path.join(x.root, 'new-library');
    await customGameStore.updateCustomEntries(nextRoot, () => [entry('new library')]);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const migration = backupCoordinator.withLibraryLock(async () => { await gate; x.settings.backupPath = nextRoot; });
    const loading = x.load();
    release();
    await migration;
    assert.equal((await loading)[0].title, 'new library');
});
