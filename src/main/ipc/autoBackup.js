

const {
  startAutoBackup,
  stopAutoBackup,
  getAutoBackupState
} = require('../backup/autoBackup');

function registerAutoBackupIpc(ipcMain) {
// ======================================================================
// Auto backup
// ======================================================================

// Auto backup IPC handlers
ipcMain.handle('start-auto-backup', async (event, wikiId, mode, intervalMinutes) => {
    await startAutoBackup(wikiId, mode, intervalMinutes);
});

ipcMain.handle('stop-auto-backup', async (event, wikiId) => {
    return await stopAutoBackup(wikiId, true);
});

ipcMain.handle('get-auto-backup-state', () => {
    return getAutoBackupState();
});

}
module.exports = { registerAutoBackupIpc };
