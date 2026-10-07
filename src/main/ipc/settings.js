const { BrowserWindow, dialog, shell } = require('electron');

const path = require('path');

const i18next = require('i18next');

const { saveSettings, getSettings } = require('../global');
const { getGameData, detectGamePaths } = require('../games/gameData');

const { refreshAutoBackupWatchers } = require('../backup/autoBackup');

const { publicSettings } = require('../settings/validation');

function registerSettingsIpc(ipcMain) {
  // ======================================================================
  // Settings and dialogs
  // ======================================================================

  ipcMain.handle('translate', async (event, key, options) => {
    return i18next.t(key, options);
  });

  ipcMain.handle('save-settings', async (event, keyOrUpdates, value) => {
    const changedKeys = await saveSettings(keyOrUpdates, value);
    if (changedKeys === null) {
      return false;
    }

    if (changedKeys.includes('backupAllAccounts')) {
      await refreshAutoBackupWatchers();
    }

    return true;
  });

  ipcMain.on('load-theme', (event) => {
    event.reply('apply-theme', getSettings().theme);
  });

  ipcMain.handle('get-settings', () => {
    return publicSettings(getSettings());
  });

  ipcMain.handle('get-detected-game-paths', async () => {
    await detectGamePaths();
    return getGameData().detectedGamePaths;
  });

  ipcMain.handle('open-url', async (event, url) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('open-backup-dialog', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    const result = await dialog.showOpenDialog(focusedWindow, {
      title: i18next.t('settings.select_backup_path'),
      properties: ['openDirectory'],
      modal: true,
    });

    if (result.filePaths.length > 0) {
      return path.join(result.filePaths[0], 'GSM Backups');
    }

    return null;
  });

  ipcMain.handle('open-dialog', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    const result = await dialog.showOpenDialog(focusedWindow, {
      title: i18next.t('settings.select_path'),
      properties: ['openDirectory'],
      modal: true,
    });

    return result;
  });

  ipcMain.handle('select-path', async (event, fileType) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    let dialogOptions = {
      title: i18next.t('settings.select_path'),
      properties: [],
    };

    switch (fileType) {
      case 'file':
        dialogOptions.properties = ['openFile'];
        break;
      case 'folder':
        dialogOptions.properties = ['openDirectory'];
        break;
      case 'registry':
        return null;
      case 'gsmr':
        dialogOptions.properties = ['openFile'];
        dialogOptions.filters = [
          { name: i18next.t('main.gsmr-file-type'), extensions: ['gsmr'] },
        ];
        break;
    }

    const result = await dialog.showOpenDialog(focusedWindow, {
      ...dialogOptions,
      modal: true,
    });

    if (result.filePaths.length > 0) {
      return result.filePaths[0];
    }

    return null;
  });
}
module.exports = { registerSettingsIpc };
