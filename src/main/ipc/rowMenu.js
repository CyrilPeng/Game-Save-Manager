

const {
  getMainWin
} = require('../global');

const { showRowMenu, placeAndShowRowMenu, hideRowMenu } = require('../app/menuWindow');

function registerRowMenuIpc(ipcMain) {
// ======================================================================
// Row menu
// ======================================================================

// Floating row menu: the renderer builds the items, main owns only placement.
ipcMain.on('show-row-menu', (event, payload) => {
    showRowMenu(getMainWin(), payload);
});

ipcMain.on('row-menu-measured', (event, size) => {
    placeAndShowRowMenu(size);
});

ipcMain.on('hide-row-menu', () => {
    hideRowMenu();
});

ipcMain.on('row-menu-action', (event, action) => {
    hideRowMenu();
    const mainWin = getMainWin();
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('row-menu-action', action);
    }
});

}
module.exports = { registerRowMenuIpc };
