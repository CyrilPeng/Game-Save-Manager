const path = require('path');
const { dialog } = require('electron');
const i18next = require('i18next');
const { getMainWin } = require('../app/windows');
async function chooseRestoreDestination(entry) {
    if (entry.type === 'reg') return null;
    const title = `${i18next.t('settings.select_path')} — ${entry.folder || entry.folder_name}${entry.originalMissing ? ` — ${i18next.t('cloud.restore_missing_target')}` : ''}`;
    if (entry.type === 'file') {
        const result = await dialog.showSaveDialog(getMainWin(), { title, defaultPath: path.basename(entry.template || 'save.dat') });
        return result.canceled ? null : result.filePath;
    }
    const result = await dialog.showOpenDialog(getMainWin(), { title, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
}

// Names by wiki id, for hidden games that may have no backups or be uninstalled
module.exports = { chooseRestoreDestination };
