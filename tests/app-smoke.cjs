// Runs the built application in a temporary profile, then (optionally) its ASAR.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-app-smoke-'));
  const env = { ...process.env, NODE_ENV: 'test', GSM_SMOKE_ROOT: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require('electron'),
    [__filename, ...(packaged ? ['--packaged'] : [])],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Launcher account discovery may log private local account IDs. Only emit the result.
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
  });
  child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => {
    child.kill();
    console.error('Application smoke test exceeded 90 seconds');
    process.exitCode = 1;
  }, 90000);
  child.on('error', (error) => {
    clearTimeout(timer);
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
    const result = output
      .split(/\r?\n/)
      .find((line) => line.startsWith('GSM_SMOKE_RESULT '));
    if (result) console.log(result);
    process.exitCode = code === 0 && result && !process.exitCode ? 0 : 1;
  });
} else {
  run().catch((error) => {
    console.error(error.stack);
    require('electron').app.exit(1);
  });
}
async function run() {
  const { app, BrowserWindow, Menu } = require('electron');
  const { randomUUID, createHash } = require('node:crypto');
  fs.mkdirSync(path.join(root, 'test-output'), { recursive: true });
  const traceFile = path.join(
    root,
    'test-output',
    packaged ? 'packaged-smoke-trace.log' : 'app-smoke-trace.log',
  );
  fs.writeFileSync(traceFile, '');
  const step = (label) =>
    fs.appendFileSync(traceFile, Date.now() + ' ' + label + '\n');
  step('begin');
  app.on('before-quit', () => step('before-quit'));
  app.on('will-quit', () => step('will-quit'));
  const temp = process.env.GSM_SMOKE_ROOT;
  const profile = path.join(temp, 'profile');
  const backups = path.join(temp, 'backups');
  const save = path.join(temp, 'save.dat');
  const bundleRoot = path.join(root, 'dist/release/win-unpacked');
  const asar = path.join(bundleRoot, 'resources/app.asar');
  const appRoot = packaged ? asar : root;
  const metadata = JSON.parse(
    fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'),
  );
  const sourceMetadata = require('../package.json');
  const productName = sourceMetadata.build.productName;
  assert.equal(metadata.version, sourceMetadata.version);
  app.setAppPath(appRoot);
  app.setName(productName);
  app.setVersion(metadata.version);
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  if (packaged) {
    // Run the packaged module graph and resource paths under the same Electron version.
    Object.defineProperty(app, 'isPackaged', { value: true });
    const getPath = app.getPath.bind(app);
    app.getPath = (name) =>
      name === 'exe'
        ? path.join(bundleRoot, productName + '.exe')
        : getPath(name);
    assert.ok(fs.existsSync(app.getPath('exe')));
  }
  fs.mkdirSync(path.join(profile, 'GSM Settings'), { recursive: true });
  fs.mkdirSync(backups);
  fs.writeFileSync(save, 'original game save');
  fs.writeFileSync(
    path.join(profile, 'GSM Settings/settings.json'),
    JSON.stringify({
      theme: 'dark',
      language: 'zh_CN',
      backupPath: backups,
      gameInstalls: [],
      autoAppUpdate: false,
      autoDbUpdate: false,
      autoBackupGames: {},
      uid: randomUUID(),
    }),
  );
  const errors = [];
  const pendingLoads = new Map();
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('console-message', (event, ...args) => {
      const level = event.level ?? args[0];
      if (level === 'error' || level === 3)
        errors.push(event.message ?? args[1]);
    });
    pendingLoads.set(
      window.id,
      new Promise((resolve, reject) => {
        window.webContents.once('did-finish-load', resolve);
        window.webContents.once('did-fail-load', (_event, code, message) =>
          reject(new Error(code + ': ' + message)),
        );
      }),
    );
  });
  const deadline = setTimeout(() => {
    console.error('Application startup deadline exceeded');
    app.exit(1);
  }, 80000);
  process.on('unhandledRejection', (error) => {
    console.error(error);
    app.exit(1);
  });
  app.on('quit', () => {
    step('quit');
    clearTimeout(deadline);
  });
  require(path.join(appRoot, 'dist/out/main/main.js'));
  await app.whenReady();
  const waitFor = async (check, label) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      console.error(
        JSON.stringify({
          label,
          url: window.webContents.getURL(),
          errors,
          debug: await window.webContents.executeJavaScript(
            '({ toolbarButtons: document.querySelectorAll("#cloud-content .cloud-toolbar button").length, cloudMarkup: document.getElementById("cloud-content")?.innerHTML, dialogs: document.querySelectorAll("dialog[open]").length })',
          ),
        }),
      );
    }
    throw new Error('Timed out: ' + label);
  };
  const main = await waitFor(
    () =>
      BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/index.html'),
      ),
    'main window',
  );
  await pendingLoads.get(main.id);
  const invoke = (channel, ...args) =>
    main.webContents.executeJavaScript(
      'window.api.invoke(' +
        JSON.stringify(channel) +
        ', ...' +
        JSON.stringify(args) +
        ')',
    );
  await waitFor(
    async () =>
      !(await invoke('get-status')).updating_backup &&
      (await main.webContents.executeJavaScript(
        'document.getElementById("backup-button").disabled === false',
      )),
    'initial backup table',
  );
  assert.equal(await invoke('get-current-version'), metadata.version);
  const cloud = await main.webContents.executeJavaScript(
    'window.api.cloud.getState()',
  );
  assert.equal(cloud.ok, true);
  assert.equal(cloud.data.targets.length, 0);
  assert.ok(fs.existsSync(path.join(profile, 'GSM Database/database.db')));
  assert.equal(
    createHash('sha256')
      .update(fs.readFileSync(path.join(profile, 'GSM Database/database.db')))
      .digest('hex'),
    require('../resources/database/database-manifest.json').sha256,
  );

  const id = randomUUID();
  await invoke('load-custom-entries');
  assert.equal(
    await invoke('save-custom-entries', [
      {
        wiki_page_id: id,
        title: 'Smoke Test Game',
        install_folder: '',
        save_location: {
          win: [{ template: save, type: 'file' }],
          reg: [],
          mac: [],
          linux: [],
        },
      },
    ]),
    true,
  );
  const games = await invoke('fetch-backup-table-data', false, id);
  assert.equal(games.length, 1);
  const backed = await invoke('backup-game', games[0]);
  assert.equal(backed, null);
  step('backup completed');
  fs.writeFileSync(save, 'changed after backup');
  const versions = await invoke('fetch-restore-table-data', id);
  assert.equal(versions.length, 1);
  const restored = await invoke('restore-game', versions[0], 'replace');
  assert.equal(restored.error, null);
  assert.equal(fs.readFileSync(save, 'utf8'), 'original game save');
  assert.ok(restored.protectionSnapshotId);
  step('restore completed');

  await main.webContents.executeJavaScript(
    'document.getElementById("cloud-tab").click()',
  );
  await waitFor(
    () =>
      main.webContents.executeJavaScript(
        'document.querySelectorAll("#cloud-content .cloud-toolbar:first-of-type button").length === 2',
      ),
    'cloud page',
  );
  await main.webContents.executeJavaScript(
    'document.querySelectorAll("#cloud-content .cloud-toolbar:first-of-type button")[1].click()',
  );
  await waitFor(
    () =>
      main.webContents.executeJavaScript(
        'Boolean(document.querySelector("dialog[open] input"))',
      ),
    'cloud settings dialog',
  );
  await main.webContents.executeJavaScript(
    'document.querySelector("dialog[open]").close()',
  );
  Menu.getApplicationMenu().items[0].submenu.items[0].click();
  const settings = await waitFor(
    () =>
      BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/settings.html'),
      ),
    'settings window',
  );
  await pendingLoads.get(settings.id);
  await waitFor(
    () =>
      settings.webContents.executeJavaScript(
        'document.getElementById("language").value === "zh_CN"',
      ),
    'settings page initialization',
  );
  await settings.webContents.executeJavaScript(
    'const theme = document.getElementById("theme"); theme.value = "light"; theme.dispatchEvent(new Event("change", { bubbles: true }));',
  );
  await waitFor(
    async () => (await invoke('get-settings')).theme === 'light',
    'settings transaction',
  );
  await waitFor(
    () =>
      main.webContents.executeJavaScript(
        'document.documentElement.classList.contains("light") || !document.documentElement.classList.contains("dark")',
      ),
    'theme broadcast',
  );
  assert.deepEqual(errors, []);
  step('pages checked');
  fs.mkdirSync(path.join(root, 'test-output'), { recursive: true });
  settings.close();
  console.log(
    'GSM_SMOKE_RESULT ' +
      JSON.stringify({
        ok: true,
        mode: packaged ? 'asar' : 'built',
        version: metadata.version,
        realBootstrap: true,
        realRenderer: true,
        settings: true,
        cloudDialog: true,
        localBackupRestore: true,
        protectionBackup: true,
      }),
  );
  step('quit requested');
  app.quit();
}
