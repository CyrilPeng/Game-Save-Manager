const fsOriginal = require('original-fs');
const path = require('path');
const moment = require('moment');
const i18next = require('i18next');
const snapshotStore = require('./snapshotStore');
const { getSettings } = require('../settings/store');
function getNewestBackup(wiki_page_id) {
    const backupDir = path.join(getSettings().backupPath, wiki_page_id.toString());

    // One readdir answers both "does it exist" and "what type is each entry"
    let backups = [];
    try {
        backups = fsOriginal.readdirSync(backupDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('./backup'))
            .flatMap(dirent => {
                try {
                    const metadata = JSON.parse(fsOriginal.readFileSync(path.join(backupDir, dirent.name, 'backup_info.json'), 'utf8'));
                    return [snapshotStore.normalizeMetadata(metadata, String(wiki_page_id), dirent.name)];
                } catch { return []; }
            });
    } catch {
        return i18next.t('main.no_backups');
    }

    if (backups.length === 0) {
        return i18next.t('main.no_backups');
    }

    const latestBackup = backups.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return moment(latestBackup.createdAt).format('YYYY/MM/DD HH:mm');
}

module.exports = { getNewestBackup };
