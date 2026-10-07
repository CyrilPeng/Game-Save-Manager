const { ipcMain } = require('electron');

function registerAppIpc(context) {
    require('./settings').registerSettingsIpc(ipcMain);
    require('./games').registerGamesIpc(ipcMain);
    require('./tables').registerTablesIpc(ipcMain);
    require('./backups').registerBackupsIpc(ipcMain, context);
    require('./transfers').registerTransfersIpc(ipcMain);
    require('./autoBackup').registerAutoBackupIpc(ipcMain);
    require('./rowMenu').registerRowMenuIpc(ipcMain);
}
module.exports = { registerAppIpc };
