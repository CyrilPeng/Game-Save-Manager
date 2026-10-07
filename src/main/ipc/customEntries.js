const customGameStore = require('../games/customGameStore');
const backupCoordinator = require('../backup/backupCoordinator');
const { getSettings } = require('../settings/store');
const { getMainWin } = require('../app/windows');
const i18next = require('i18next');

function registerCustomEntriesIpc(ipcMain, dependencies = { customGameStore, backupCoordinator, getSettings, getMainWin, i18next }) {
const { customGameStore, backupCoordinator, getSettings, getMainWin, i18next } = dependencies;
const customEntryBaselines = new WeakMap();
ipcMain.handle('save-custom-entries', async (event, jsonObj) => {
    try {
        const { changed } = await backupCoordinator.withLibraryRead(async () => {
            const root = getSettings().backupPath;
            const baseline = customEntryBaselines.get(event.sender);
            const result = await customGameStore.updateCustomEntries(root, entries => {
                if (!baseline || baseline.root !== root || baseline.json !== JSON.stringify(entries)) {
                    throw Object.assign(new Error(i18next.t('alert.custom_entries_changed')), { code: 'CUSTOM_ENTRIES_CHANGED' });
                }
                return jsonObj;
            });
            customEntryBaselines.set(event.sender, { root, json: JSON.stringify(jsonObj) });
            return result;
        });
        if (changed) {
            getMainWin().webContents.send('show-alert', 'success', i18next.t('alert.save_custom_success'));
            getMainWin().webContents.send('update-backup-table');
        }
        return true;

    } catch (error) {
        console.error(`Error saving custom games: ${error.stack}`);
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.save_custom_error'), error.message);
        return false;
    }
});

ipcMain.handle('load-custom-entries', async event => {
    try {
        return await backupCoordinator.withLibraryRead(async () => {
            const root = getSettings().backupPath;
            const entries = await customGameStore.readCustomEntries(root);
            customEntryBaselines.set(event.sender, { root, json: JSON.stringify(entries) });
            return entries;
        });

    } catch (error) {
        customEntryBaselines.delete(event.sender);
        console.error(`Error loading custom games: ${error.stack}`);
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.load_custom_error'), error.message);
        return [];
    }
});


}
module.exports = { registerCustomEntriesIpc };
