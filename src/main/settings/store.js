const { BrowserWindow, Menu, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const i18next = require('i18next');
const { initializeMenu, getMainWin } = require('../app/windows');
const { validateSettingsUpdates, publicSettings } = require('./validation');
let settings;
let writeQueue = Promise.resolve();
function setLaunchAtStartup(enabled) {
  if (
    !app.isPackaged ||
    (process.platform !== 'win32' && process.platform !== 'darwin')
  ) {
    return;
  }

  const loginItemSettings = {
    openAtLogin: Boolean(enabled),
  };

  if (process.platform === 'win32') {
    loginItemSettings.path = process.execPath;
    loginItemSettings.args = [];
    loginItemSettings.name = 'Game Save Manager';
  }

  app.setLoginItemSettings(loginItemSettings);
}

const loadSettings = () => {
  const userDataPath = app.getPath('userData');
  const appDataPath = app.getPath('appData');
  const settingsPath = path.join(userDataPath, 'GSM Settings', 'settings.json');

  const mapSupportedLanguage = (language) => {
    const locale = new Intl.Locale(language).maximize();
    if (locale.language === 'en') return 'en_US';
    if (locale.language === 'pt' && locale.region === 'BR') return 'pt_BR';
    if (locale.language === 'zh')
      return locale.script === 'Hant' ? 'zh_TW' : 'zh_CN';
    return null;
  };

  const preferredLanguages = app.getPreferredSystemLanguages();
  console.log(`Preferred languages: ${preferredLanguages}`);
  const detectedLanguage =
    preferredLanguages.map(mapSupportedLanguage).find(Boolean) || 'en_US';

  // Default settings
  const defaultSettings = {
    theme: 'dark',
    language: detectedLanguage,
    backupPath: path.join(appDataPath, 'GSM Backups'),
    exportPath: '',
    maxBackups: 5,
    launchAtStartup: false,
    autoAppUpdate: true,
    autoDbUpdate: false,
    backupAllAccounts: false,
    saveUninstalledGames: true,
    gameInstalls: 'uninitialized',
    pinnedGames: [],
    hiddenGames: [],
    uninstalledGames: [],
    autoBackupGames: {},
  };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  try {
    const data = fs.readFileSync(settingsPath, 'utf8');
    settings = { ...defaultSettings, ...publicSettings(JSON.parse(data)) };
  } catch (err) {
    console.error('Cannot load settings; using defaults for this session.');
    if (err.code === 'ENOENT')
      fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings), 'utf8');
    else
      fs.copyFileSync(settingsPath, `${settingsPath}.unreadable-${Date.now()}`);
    settings = defaultSettings;
  }
};

/** Serialize transactions and expose new settings only after the disk commit succeeds. */
async function saveSettings(keyOrUpdates, value) {
  const updates =
    keyOrUpdates &&
    typeof keyOrUpdates === 'object' &&
    !Array.isArray(keyOrUpdates)
      ? keyOrUpdates
      : { [keyOrUpdates]: value };
  if (!validateSettingsUpdates(updates)) return null;
  const requested = JSON.parse(JSON.stringify(updates));
  const filename = path.join(
    app.getPath('userData'),
    'GSM Settings',
    'settings.json',
  );
  const operation = writeQueue
    .then(async () => {
      const updatedKeys = Object.keys(requested);
      const changedKeys = updatedKeys.filter(
        (key) => !Object.is(settings[key], requested[key]),
      );
      const nextSettings = { ...settings, ...requested };
      const temporary = filename + '.pending-' + randomUUID();
      try {
        await fs.promises.writeFile(temporary, JSON.stringify(nextSettings), {
          flag: 'wx',
        });
        await fs.promises.rename(temporary, filename);
      } finally {
        await fs.promises.rm(temporary, { force: true });
      }
      settings = nextSettings;
      try {
        if (updatedKeys.includes('launchAtStartup')) {
          setLaunchAtStartup(requested.launchAtStartup);
        }

        if (changedKeys.includes('theme')) {
          BrowserWindow.getAllWindows().forEach((window) => {
            window.webContents.send('apply-theme', requested.theme);
          });
        }

        if (
          changedKeys.some(
            (key) => key === 'gameInstalls' || key === 'saveUninstalledGames',
          ) &&
          getMainWin() &&
          !getMainWin().isDestroyed()
        ) {
          getMainWin().webContents.send('update-backup-table');
        }

        if (changedKeys.includes('language')) {
          await i18next.changeLanguage(requested.language);
          BrowserWindow.getAllWindows().forEach((window) => {
            window.webContents.send('apply-language');
          });
          const menu = Menu.buildFromTemplate(initializeMenu());
          Menu.setApplicationMenu(menu);
        }
      } catch (error) {
        console.error('Settings saved, but a UI effect failed:', error);
      }
      return changedKeys;
    })
    .catch((error) => {
      console.error('Settings transaction failed:', error);
      return null;
    });
  writeQueue = operation.then(() => undefined);
  return operation;
}
module.exports = { loadSettings, saveSettings, getSettings: () => settings };
