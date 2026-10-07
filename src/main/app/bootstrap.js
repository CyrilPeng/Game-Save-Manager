const {
  BrowserWindow,
  app,
  ipcMain,
  safeStorage,
  session
} = require('electron');

const { randomUUID } = require('crypto');

const path = require('path');
const { pathToFileURL } = require('url');

const i18next = require('i18next');
const Backend = require('i18next-fs-backend');

const {
  createMainWindow,
  getMainWin,
  checkAppUpdate,
  loadSettings,
  saveSettings,
  getSettings
} = require('../global');
const {
  getGameData,
  initializeGameData,
  detectGamePaths
} = require('../games/gameData');

const {
  restoreSnapshot
} = require('../backup/restore');
const {
  restoreAutoBackups,
  stopAllAutoBackups
} = require('../backup/autoBackup');

const { createCloudService } = require('../cloud/service');
const { registerCloudIpc, CLOUD_CHANNELS } = require('../cloud/ipc');

let cloudService;
let cloudClosed = false;
let cloudClosing = false;
const { registerAppIpc } = require('../ipc/register');
const { chooseRestoreDestination } = require('../ipc/restoreDestination');
registerAppIpc({ getCloudService: () => cloudService });
const trustedCloudURLs = ['index.html', 'settings.html'].map(file => pathToFileURL(path.join(__dirname, '../renderer', file)).href);

app.on('before-quit', event => {
    if (!cloudService || cloudClosed) return;
    event.preventDefault();
    if (cloudClosing) return;
    cloudClosing = true;
    stopAllAutoBackups();
    cloudService.close().catch(() => {}).finally(() => {
        require('../backup/archive').cancelAll();
        cloudClosed = true;
        app.quit();
    });
});

// Setup hot reload for development
if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    try {
        const setupHotReload = require('./hotReload');
        setupHotReload();
    } catch (err) {
        console.error('Failed to setup hot reload:', err.message);
    }
}

app.commandLine.appendSwitch("lang", "en");
const gotTheLock = app.requestSingleInstanceLock();
let pendingGSMPath = null;

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, argv) => {
        const gsmPath = argv.find(arg => arg.toLowerCase().endsWith('.gsmr'));
        const uriPath = argv.find(arg => arg.startsWith('gamesavemanager://'));
        if (gsmPath) {
            getMainWin().webContents.send('open-import-modal', gsmPath);
        }
        else if (uriPath) {
            const action = uriPath.replace('gamesavemanager://', '').replace('/', '');
            ipcMain.emit('notification-action', null, action);
        }
    });

    app.on('will-quit', () => {
        stopAllAutoBackups();

    });

    if (process.platform === 'win32') {
        const gsmPath = process.argv.find(arg => arg.toLowerCase().endsWith('.gsmr'));
        if (gsmPath) {
            pendingGSMPath = gsmPath;
        }
    }
}

app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient('gamesavemanager');

    loadSettings();
    await initializeI18next(getSettings().language);
    await initializeGameData();

    if (!getSettings().uid) {
        await saveSettings('uid', randomUUID());
    }

    if (getSettings().gameInstalls === 'uninitialized') {
        await detectGamePaths();
        await saveSettings('gameInstalls', getGameData().detectedGamePaths);
    }

    try {
        cloudService = await createCloudService({ userDataPath: app.getPath('userData'), safeStorage,
            getBackupPath: () => getSettings().backupPath, restoreSnapshot,
            chooseRestoreMapping: chooseRestoreDestination,
            resolveProxy: url => session.defaultSession.resolveProxy(url),
            onUpdate: state => {
                for (const window of BrowserWindow.getAllWindows()) {
                    if (!window.isDestroyed() && trustedCloudURLs.includes(window.webContents.getURL())) window.webContents.send('cloud:state', state);
                }
            }
        });
        registerCloudIpc(ipcMain, cloudService, {
            getTrustedWebContents: () => BrowserWindow.getAllWindows().map(window => window.webContents),
            trustedURL: trustedCloudURLs
        });
    } catch {
        // Failure to open the separate cloud store must not prevent local backups.
        console.error('Cloud storage initialization failed; local backups remain available.');
        for (const channel of CLOUD_CHANNELS) ipcMain.handle(channel, () => ({ ok: false, error: { code: 'CLOUD_ERROR', message: 'Cloud storage is unavailable.' } }));
    }
    await createMainWindow();
    app.setAppUserModelId(require('../../project').appId);

    if (getSettings().autoAppUpdate) {
        checkAppUpdate();
    }

    await restoreAutoBackups();

    getMainWin().webContents.once('did-finish-load', () => {
        if (pendingGSMPath) {
            getMainWin().webContents.send('open-import-modal', pendingGSMPath);
            pendingGSMPath = null;
        }
    });

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

// Language settings
const initializeI18next = (language) => {
    return i18next
        .use(Backend)
        .init({
            lng: language,
            fallbackLng: "en_US",
            backend: {
                loadPath: path.join(__dirname, "../locale/{{lng}}.json"),
            },
        });
};

