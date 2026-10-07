// Run with: npm run test:electron
// Uses only temporary local data, hidden windows and a loopback WebDAV fixture.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const timeout = setTimeout(() => {
    console.error('Cloud Electron end-to-end test exceeded 60 seconds.');
    child.kill();
    process.exitCode = 1;
  }, 60000);
  child.once('error', (error) => {
    clearTimeout(timeout);
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    process.exitCode = code === 0 && !process.exitCode ? 0 : 1;
  });
} else {
  runElectron().catch((error) => {
    console.error(error.stack);
    require('electron').app.exit(1);
  });
}

async function runElectron() {
  const assert = require('node:assert/strict');
  const http = require('node:http');
  const { randomUUID } = require('node:crypto');
  const { pathToFileURL } = require('node:url');
  const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
  const { createCloudService } = require('../src/main/cloud/service');
  const { registerCloudIpc } = require('../src/main/cloud/ipc');
  const snapshots = require('../src/main/backup/snapshotStore');
  // Chromium expands Windows short path aliases when navigating to a file URL.
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-electron-e2e-')),
  );
  app.setPath('userData', path.join(root, 'electron-profile'));
  app.disableHardwareAcceleration();
  // Closing device A's hidden window must not quit before device B starts.
  app.on('window-all-closed', () => {});
  const username = 'gsm-integration-user';
  const password = 'gsm-local-fixture-secret';
  const auth =
    'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const nodes = new Map([['/', null]]);
  const requests = [];
  const activeWindows = new Set();
  let activeService;
  let unregister;
  let server;
  let exitCode = 1;
  const timeout = setTimeout(() => {
    console.error('Electron fixture deadline exceeded.');
    app.exit(1);
  }, 55000);
  const preload = path.resolve(__dirname, '../dist/out/preload/preload.js');
  const fixture = path.join(root, 'trusted-fixture.html');
  const fixtureURL = pathToFileURL(fixture).href;

  function xmlEscape(value) {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }
  function resource(key) {
    const data = nodes.get(key);
    const directory = data === null;
    const href =
      key.split('/').map(encodeURIComponent).join('/') +
      (directory && key !== '/' ? '/' : '');
    return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${data?.length || 0}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }

  async function handleRequest(req, res) {
    if (req.headers.authorization !== auth) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="GSM test"' });
      res.end();
      return;
    }
    const key =
      decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(
        /\/$/,
        '',
      ) || '/';
    requests.push({ method: req.method, key, depth: req.headers.depth });
    if (req.method === 'MKCOL') {
      if (nodes.has(key)) res.writeHead(405);
      else if (!nodes.has(path.posix.dirname(key))) res.writeHead(409);
      else {
        nodes.set(key, null);
        res.writeHead(201);
      }
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && nodes.has(key)) {
        res.writeHead(412);
        res.end();
        return;
      }
      if (!nodes.has(path.posix.dirname(key))) {
        res.writeHead(409);
        res.end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          res.writeHead(413);
          res.end();
          return;
        }
        chunks.push(chunk);
      }
      if (Number(req.headers['content-length']) !== size) {
        res.writeHead(400);
        res.end();
        return;
      }
      nodes.set(key, Buffer.concat(chunks));
      res.writeHead(201);
      res.end();
      return;
    }
    if (!nodes.has(key)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === 'GET') {
      const data = nodes.get(key);
      if (!data) {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(data.length),
      });
      res.end(data);
      return;
    }
    if (req.method === 'DELETE') {
      nodes.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'PROPFIND') {
      assert.ok(
        ['0', '1'].includes(req.headers.depth),
        'WebDAV must use bounded Depth 0/1',
      );
      const children =
        req.headers.depth === '1'
          ? [...nodes.keys()].filter(
              (child) => child !== key && path.posix.dirname(child) === key,
            )
          : [];
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(
        `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${[key, ...children].map(resource).join('')}</d:multistatus>`,
      );
      return;
    }
    res.writeHead(405);
    res.end();
  }

  async function windowForDevice(device) {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `gsm-e2e-${device}-${randomUUID()}`,
      },
    });
    activeWindows.add(window);
    window.on('closed', () => activeWindows.delete(window));
    await window.loadFile(fixture);
    assert.equal(
      window.webContents.getURL(),
      fixtureURL,
      'The trusted fixture must use the same canonical file URL as Chromium',
    );
    assert.equal(
      await window.webContents.executeJavaScript(
        'typeof window.api.cloud.getState',
      ),
      'function',
    );
    return window;
  }

  async function invoke(window, method, input = {}) {
    const response = await window.webContents.executeJavaScript(
      `window.api.cloud[${JSON.stringify(method)}](${JSON.stringify(input)})`,
    );
    assert.equal(
      response.ok,
      true,
      `${method}: ${response.error?.code || 'no result'}`,
    );
    assert.ok(
      !JSON.stringify(response).includes(password),
      `${method} leaked credentials to renderer`,
    );
    return response.data;
  }

  async function waitJob(window, id) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await invoke(window, 'getState');
      const job = state.jobs.find((item) => item.id === id);
      assert.ok(job, 'IPC task must exist');
      if (job.stage === 'succeeded') return job;
      assert.ok(
        !['failed', 'cancelled', 'paused'].includes(job.stage),
        `Task ${job.kind}: ${job.error?.code || job.stage}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Cloud task did not complete through IPC');
  }

  async function startDevice(name) {
    const userData = path.join(root, name);
    const backupRoot = path.join(userData, 'backups');
    await fsp.mkdir(backupRoot, { recursive: true });
    const window = await windowForDevice(name);
    activeService = await createCloudService({
      userDataPath: userData,
      safeStorage,
      getBackupPath: () => backupRoot,
      onUpdate: (state) => {
        if (!window.isDestroyed())
          window.webContents.send('cloud:state', state);
      },
    });
    unregister = registerCloudIpc(ipcMain, activeService, {
      getTrustedWebContents: () => window.webContents,
      trustedURL: fixtureURL,
    });
    await window.webContents.executeJavaScript(
      'window.__cloudEvents = 0; window.api.cloud.onState(() => { window.__cloudEvents++; }); true;',
    );
    const state = await invoke(window, 'getState');
    assert.deepEqual(state.targets, []);
    assert.deepEqual(state.jobs, []);
    assert.deepEqual(state.versions, []);
    assert.deepEqual(await invoke(window, 'listLocalSnapshots'), []);
    await invoke(window, 'setDevice', { name: `Fixture ${name}` });
    return { window, userData, backupRoot, id: state.device.id };
  }

  async function stopDevice(device) {
    unregister?.();
    unregister = null;
    await activeService.close();
    activeService = null;
    device.window.destroy();
  }

  try {
    await fsp.writeFile(
      fixture,
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'"><title>GSM isolated IPC test</title>',
    );
    await app.whenReady();
    assert.equal(
      safeStorage.isEncryptionAvailable(),
      true,
      'Real Electron protected storage is required',
    );
    assert.equal(
      safeStorage.decryptString(safeStorage.encryptString(password)),
      password,
    );
    server = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        console.error(error.message);
        res.destroy();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const config = {
      type: 'webdav',
      name: 'Loopback fixture',
      url: `http://127.0.0.1:${server.address().port}`,
      prefix: '云端备份 e2e',
      allowInsecureHttp: true,
      proxy: { mode: 'direct' },
    };

    const a = await startDevice('A');
    const stranger = await windowForDevice('untrusted');
    const refused = await stranger.webContents.executeJavaScript(
      'window.api.cloud.getState()',
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'UNTRUSTED_SENDER');
    stranger.destroy();
    assert.equal(
      await a.window.webContents.executeJavaScript(
        '(() => { try { window.api.invoke("cloud:getState"); return false; } catch { return true; } })()',
      ),
      true,
    );

    const snapshotId = randomUUID();
    const createdAt = new Date().toISOString();
    const folder = `${createdAt.replace(/[:.]/g, '-')}_${snapshotId}`;
    const source = path.join(a.backupRoot, '42', folder);
    const saveBytes = Buffer.from(
      Array.from(
        { length: 65536 },
        (_, index) => (index * 17 + (index % 251)) & 255,
      ),
    );
    await fsp.mkdir(path.join(source, 'path1'), { recursive: true });
    await fsp.writeFile(
      path.join(source, 'path1', 'slot 日本語.sav'),
      saveBytes,
    );
    await snapshots.atomicWriteJson(path.join(source, 'backup_info.json'), {
      schemaVersion: 1,
      minimumReaderVersion: 1,
      snapshotId,
      gameKey: 'pcgw:42',
      createdAt,
      title: 'Integration 存档',
      unexpectedSecret: 'must-never-enter-cloud-metadata',
      backup_paths: [
        {
          folder_name: 'path1',
          type: 'folder',
          template: '{{p|appdata}}/GSMIntegrationFixture',
        },
      ],
    });
    let aTarget = await invoke(a.window, 'saveTarget', {
      config,
      secrets: { username, password },
    });
    assert.equal(aTarget.credentialsConfigured, true);
    assert.equal(aTarget.sessionOnly, false);
    const aProbe = await invoke(a.window, 'testConnection', {
      targetId: aTarget.id,
    });
    for (const capability of [
      'authentication',
      'list',
      'write',
      'readback',
      'delete',
    ])
      assert.equal(aProbe[capability], true, `probe ${capability}`);
    aTarget = await invoke(a.window, 'createRepository', {
      targetId: aTarget.id,
    });
    assert.ok(aTarget.repositoryId);
    assert.equal(
      (await invoke(a.window, 'listLocalSnapshots'))[0].snapshotId,
      snapshotId,
    );
    const upload = await invoke(a.window, 'upload', {
      targetId: aTarget.id,
      gameId: '42',
      folder,
    });
    await waitJob(a.window, upload.id);
    const aVersions = (
      await invoke(a.window, 'refresh', { targetId: aTarget.id })
    ).versions;
    assert.equal(aVersions.length, 1);
    assert.equal(aVersions[0].snapshotId, snapshotId);
    assert.ok(
      !JSON.stringify(aVersions).includes('must-never-enter-cloud-metadata'),
    );
    const encrypted = await fsp.readFile(
      path.join(a.userData, 'GSM Cloud', 'credentials.json'),
      'utf8',
    );
    assert.ok(!encrypted.includes(password));
    assert.ok(!encrypted.includes(username));
    assert.ok(
      await a.window.webContents.executeJavaScript('window.__cloudEvents > 0'),
    );
    const payloadRead = requests.findIndex(
      (request) => request.method === 'GET' && request.key.endsWith('.gsmr'),
    );
    const manifestWrite = requests.findIndex(
      (request) =>
        request.method === 'PUT' && request.key.endsWith('/manifest.json'),
    );
    assert.ok(
      payloadRead >= 0 && manifestWrite > payloadRead,
      'Payload must be read back before manifest publication',
    );
    await stopDevice(a);

    const b = await startDevice('B');
    assert.notEqual(
      a.id,
      b.id,
      'The fresh device must have its own durable identity',
    );
    let bTarget = await invoke(b.window, 'saveTarget', {
      config,
      secrets: { username, password },
    });
    const discovered = await invoke(b.window, 'discoverRepositories', {
      targetId: bTarget.id,
    });
    assert.deepEqual(
      discovered.map((repository) => repository.id),
      [aTarget.repositoryId],
    );
    bTarget = await invoke(b.window, 'selectRepository', {
      targetId: bTarget.id,
      repositoryId: discovered[0].id,
    });
    await invoke(b.window, 'setAutomatic', {
      targetId: bTarget.id,
      gameKeys: [],
    });
    const versions = (
      await invoke(b.window, 'refresh', { targetId: bTarget.id })
    ).versions;
    assert.equal(versions.length, 1);
    assert.equal(versions[0].publisherDeviceId, a.id);
    const download = await invoke(b.window, 'download', {
      targetId: bTarget.id,
      versionId: versions[0].versionId,
    });
    const downloaded = await waitJob(b.window, download.id);
    const imported = await snapshots.readSnapshot(
      b.backupRoot,
      '42',
      downloaded.result.folder,
    );
    assert.deepEqual(
      await fsp.readFile(path.join(imported.path, 'path1', 'slot 日本語.sav')),
      saveBytes,
    );
    assert.equal(imported.snapshotId, snapshotId);
    assert.equal(imported.metadata.cloudImported, true);
    assert.equal(imported.metadata.cloudUploadIntent, undefined);
    assert.equal(imported.metadata.unexpectedSecret, undefined);
    const bState = await invoke(b.window, 'getState');
    assert.equal(bState.jobs.length, 1);
    assert.equal(bState.jobs[0].kind, 'download');
    assert.equal(
      requests.filter(
        (request) =>
          request.method === 'PUT' && request.key.endsWith('/manifest.json'),
      ).length,
      1,
      'Import must not start an upload loop',
    );
    assert.equal((await invoke(b.window, 'listLocalSnapshots')).length, 1);
    await stopDevice(b);
    console.log(
      JSON.stringify({
        ok: true,
        electron: process.versions.electron,
        node: process.versions.node,
        realPreload: true,
        trustedIPC: true,
        realSafeStorage: true,
        realWebDAV: true,
        realSQLite: true,
        realSevenZip: true,
        isolatedDevices: 2,
        uploadedAndDownloadedBytes: saveBytes.length,
        requests: requests.length,
        importUploadLoop: false,
      }),
    );
    exitCode = 0;
  } catch (error) {
    console.error(error.stack);
  } finally {
    clearTimeout(timeout);
    unregister?.();
    if (activeService) await activeService.close().catch(() => {});
    for (const window of activeWindows)
      if (!window.isDestroyed()) window.destroy();
    if (server)
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    // root is a single mkdtemp result; no user-selected paths are removed.
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    app.exit(exitCode);
  }
}
