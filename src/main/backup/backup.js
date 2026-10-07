

const { execFile } = require('child_process');

const fsOriginal = require('original-fs');

const path = require('path');
const util = require('util');

const i18next = require('i18next');

const {
  getGameDisplayName,
  readJsonFile,
  getSettings
} = require('../global');
const {
  getAllAccountIds
} = require('../games/gameData');

const snapshotStore = require('./snapshotStore');
const coordinator = require('./backupCoordinator');

const execFilePromise = util.promisify(execFile);

async function createBackupSnapshot(gameObj, options = {}) {
    const root = getSettings().backupPath;
    const gameId = snapshotStore.validateGameId(gameObj.wiki_page_id);
    const gameKey = `${/^\d+$/.test(gameId) ? 'pcgw' : 'custom'}:${gameId}`;
    const identity = snapshotStore.newSnapshotIdentity();
    const gameBackupPath = path.resolve(root, gameId);
    const finalPath = snapshotStore.snapshotPath(root, gameId, identity.folder);
    const stagingPath = path.join(gameBackupPath, `.pending-${identity.snapshotId}`);
    if (!Array.isArray(gameObj.resolved_paths) || !gameObj.resolved_paths.length) throw new Error('No save paths are available for backup');
    await snapshotStore.assertNoLinks(gameBackupPath);
    await fsOriginal.promises.mkdir(gameBackupPath, { recursive: true });
    const backupConfig = {
        schemaVersion: 1, minimumReaderVersion: 1, snapshotId: identity.snapshotId,
        createdAt: identity.createdAt, gameKey, title: gameObj.title,
        zh_CN: gameObj.zh_CN || null, platform: gameObj.platform || [],
        accountScope: getAllAccountIds(), backup_paths: [],
        ...(options.restoreProtection ? { restoreProtection: true, is_permanent: true, custom_name: i18next.t('cloud.restore_protection', { defaultValue: '恢复前保护备份' }), protectsSnapshotId: options.protectsSnapshotId } : {}),
    };
    if (!options.skipUpload) {
        try {
            const intent = await coordinator.getUploadIntent({ ...gameObj, gameId, gameKey });
            if (intent) backupConfig.cloudUploadIntent = intent;
        } catch (error) { backupConfig.cloudEnqueueError = error.message; }
    }
    if (gameKey.startsWith('custom:')) {
        const definitions = await readJsonFile(path.join(root, 'custom_entries.json')).catch(() => []);
        const entries = Array.isArray(definitions) ? definitions : Object.values(definitions);
        const definition = entries.find(entry => String(entry.wiki_page_id) === gameId);
        if (definition) backupConfig.customDefinition = definition;
    }
    let committed = false;
    try {
        await fsOriginal.promises.mkdir(stagingPath);
        for (const [index, resolvedPathObj] of gameObj.resolved_paths.entries()) {
            const resolvedPath = path.normalize(resolvedPathObj.resolved);
            const folder_name = `path${index + 1}`;
            const targetPath = path.join(stagingPath, folder_name);
            await fsOriginal.promises.mkdir(targetPath);
            const entry = {
                folder_name, template: resolvedPathObj.finalTemplate || resolvedPathObj.template || resolvedPath,
                originalTemplate: resolvedPathObj.template || null,
                type: resolvedPathObj.type || 'file', install_folder: gameObj.install_folder || null,
            };
            if (resolvedPathObj.originalMissing) {
                entry.originalMissing = true;
            } else if (resolvedPathObj.type === 'reg') {
                if (!/^HKEY_(?:CURRENT_USER|LOCAL_MACHINE|CLASSES_ROOT|USERS|CURRENT_CONFIG)\\[^\r\n]+$/i.test(resolvedPath)) throw new Error('Invalid registry save path');
                await execFilePromise('reg.exe', ['export', resolvedPath, path.join(targetPath, 'registry_backup.reg'), '/y'], { windowsHide: true });
            } else {
                await snapshotStore.assertNoLinks(resolvedPath);
                const stats = await fsOriginal.promises.stat(resolvedPath);
                entry.type = stats.isDirectory() ? 'folder' : 'file';
                if (entry.type === 'folder') {
                    if (snapshotStore.inside(resolvedPath, stagingPath, true)) throw new Error('Backup directory cannot be inside a save directory');
                    await snapshotStore.copyTree(resolvedPath, targetPath);
                } else {
                    entry.file_name = path.basename(resolvedPath);
                    await snapshotStore.copyTree(resolvedPath, path.join(targetPath, entry.file_name));
                }
            }
            backupConfig.backup_paths.push(entry);
        }
        backupConfig.backup_size = (await snapshotStore.scanTree(stagingPath)).reduce((size, entry) => size + (entry.size || 0), 0);
        snapshotStore.normalizeMetadata(backupConfig, gameId, identity.folder);
        await snapshotStore.atomicWriteJson(path.join(stagingPath, 'backup_info.json'), backupConfig);
        await fsOriginal.promises.rename(stagingPath, finalPath);
        committed = true;
        const snapshot = await snapshotStore.readSnapshot(root, gameId, identity.folder);
        if (!options.skipUpload) {
            try { await coordinator.notifyCommitted(snapshot); }
            catch (error) { console.error(`Local snapshot committed; cloud enqueue will retry: ${error.message}`); }
        }
        try { await coordinator.rotateSnapshots(root, gameId, getSettings().maxBackups); }
        catch (error) { console.error(`Local snapshot committed; rotation failed: ${error.message}`); }
        return snapshot;
    } finally {
        if (!committed) await fsOriginal.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    }
}

async function backupGame(gameObj) {
    try {
        await coordinator.withGameLock(gameObj.wiki_page_id, () => createBackupSnapshot(gameObj));
    } catch (error) {
        console.error(`Error during backup for game ${getGameDisplayName(gameObj)}: ${error.stack}`);
        return `${i18next.t('alert.backup_game_error', { game_name: getGameDisplayName(gameObj) })}: ${error.message}`;
    }

    return null;
}

module.exports = {
    ...require('../games/catalog'),
    backupGame,
    createBackupSnapshot,
};

