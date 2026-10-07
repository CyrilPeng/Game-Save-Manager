const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMainLoader } = require('./helpers/load-main.cjs');
async function fixture(t) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'gsm-settings-'),
  );
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const effects = [];
  const overrides = {
    electron: {
      app: {
        getPath: () => root,
        getPreferredSystemLanguages: () => ['zh-CN'],
      },
      BrowserWindow: {
        getAllWindows: () => [
          { webContents: { send: (...args) => effects.push(args) } },
        ],
      },
      Menu: {},
    },
    './windows': { getMainWin: () => null },
    i18next: {},
  };
  const store = createMainLoader(overrides)('settings/store');
  store.loadSettings();
  return {
    root,
    store,
    effects,
    filename: path.join(root, 'GSM Settings', 'settings.json'),
  };
}
test('settings commit failure preserves memory and disk and allows a later transaction', async (t) => {
  const x = await fixture(t);
  const before = await fs.promises.readFile(x.filename);
  const rename = fs.promises.rename.bind(fs.promises);
  t.mock.method(fs.promises, 'rename', async (source, destination) => {
    if (destination === x.filename) throw new Error('disk denied');
    return rename(source, destination);
  });
  assert.equal(await x.store.saveSettings('theme', 'light'), null);
  assert.equal(x.store.getSettings().theme, 'dark');
  assert.deepEqual(await fs.promises.readFile(x.filename), before);
  assert.deepEqual(x.effects, []);
  t.mock.restoreAll();
  assert.deepEqual(await x.store.saveSettings('theme', 'light'), ['theme']);
  assert.equal(x.store.getSettings().theme, 'light');
  assert.equal(
    JSON.parse(await fs.promises.readFile(x.filename)).theme,
    'light',
  );
  assert.deepEqual(await fs.promises.readdir(path.dirname(x.filename)), [
    'settings.json',
  ]);
});
test('concurrent settings transactions merge with the last committed state', async (t) => {
  const x = await fixture(t);
  await Promise.all([
    x.store.saveSettings('theme', 'light'),
    x.store.saveSettings('maxBackups', 7),
  ]);
  const saved = JSON.parse(await fs.promises.readFile(x.filename));
  assert.equal(saved.theme, 'light');
  assert.equal(saved.maxBackups, 7);
  assert.deepEqual(saved, x.store.getSettings());
});
