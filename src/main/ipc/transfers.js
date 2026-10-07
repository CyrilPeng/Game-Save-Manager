

const i18next = require('i18next');

const {
  getMainWin,
  getStatus,
  exportBackups,
  importBackups,
  getCurrentVersion,
  getLatestVersion,
  updateApp
} = require('../global');

const {
  getAllGameDataFromDB,
  updateDatabase
} = require('../backup/backup');

const backupCoordinator = require('../backup/backupCoordinator');

function registerTransfersIpc(ipcMain) {
// ======================================================================
// Versions and transfers
// ======================================================================

ipcMain.handle('get-current-version', () => {
    return getCurrentVersion();
});

ipcMain.handle('get-latest-version', () => {
    return getLatestVersion('GSM');
});

ipcMain.handle('update-database', async () => {
    await updateDatabase();
    return;
});

ipcMain.on('export-backups', (event, count, exportPath, wikiIds) => {
    if (backupCoordinator.isLibraryBusy?.()) { getMainWin().webContents.send('show-alert', 'warning', i18next.t('cloud.migration_busy')); return; }
    exportBackups(count, exportPath, wikiIds);
});

ipcMain.on('import-backups', (event, gsmPath) => {
    if (backupCoordinator.isLibraryBusy?.()) { getMainWin().webContents.send('show-alert', 'warning', i18next.t('cloud.migration_busy')); return; }
    importBackups(gsmPath);
});

ipcMain.handle('start-scan-full', async () => {
    if (!getStatus().scanning_full) {
        const { games, errors } = await getAllGameDataFromDB();

        if (errors.length > 0) {
            getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
        }

        return games;
    }
});

ipcMain.on('update-app', (event, latest_version) => {
    updateApp(latest_version);
});

}
module.exports = { registerTransfersIpc };
