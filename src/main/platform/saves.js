const {
  dialog,
  shell
} = require('electron');
const { exec, spawn } = require('child_process');
const { getMainWin } = require('../app/windows');

const fsOriginal = require('original-fs');

const path = require('path');
const i18next = require('i18next');

async function openRegistryAtKey(keyPath) {
    // Set the "LastKey" preference in Regedit so it opens where we want
    const safeKey = keyPath.replace(/^HKEY_/, 'Computer\\HKEY_');
    const setLastKeyCommand = `reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit" /v "LastKey" /t REG_SZ /d "${safeKey}" /f`;

    exec(setLastKeyCommand, (error) => {
        const regedit = spawn('regedit.exe', [], { detached: true, stdio: 'ignore', shell: true });
        regedit.unref();
    });
}

function deleteRegistryKey(keyPath) {
    return new Promise((resolve, reject) => {
        const cmd = `reg delete "${keyPath}" /f`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`Failed to delete registry key: ${keyPath}`, stderr);
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

async function browseLocalSave(resolvedPaths) {
    try {
        const foldersToOpen = new Set();
        let registryKeyToOpen = null;

        // 1. Sort paths into Folders vs Registry
        for (const pathObj of resolvedPaths) {
            if (pathObj.type === 'reg') {
                // Only picking the first registry key to open the editor
                if (!registryKeyToOpen) {
                    registryKeyToOpen = pathObj.resolved;
                }
            } else {
                const fullPath = pathObj.resolved;
                if (fullPath && fsOriginal.existsSync(fullPath)) {
                    const stats = fsOriginal.statSync(fullPath);
                    if (stats.isFile()) {
                        foldersToOpen.add(path.dirname(fullPath));
                    } else if (stats.isDirectory()) {
                        foldersToOpen.add(fullPath);
                    }
                }
            }
        }

        const folders = Array.from(foldersToOpen);
        const hasRegistry = !!registryKeyToOpen;

        if (folders.length === 0 && !hasRegistry) {
            getMainWin().send('show-alert', 'warning', i18next.t('alert.no_local_save_found'));
            return;
        }

        // 2. Construct dynamic message
        let message = '';
        if (folders.length > 0 && hasRegistry) {
            message = i18next.t('alert.confirm_open_folders_and_reg', {
                count: folders.length
            });
        } else if (hasRegistry) {
            message = i18next.t('alert.confirm_open_reg');
        } else {
            message = i18next.t('alert.confirm_open_folders', {
                count: folders.length
            });
        }

        // 3. Prompt User
        const response = await dialog.showMessageBox(getMainWin(), {
            type: 'question',
            title: i18next.t('main.browse_local_save'),
            message: message,
            buttons: [i18next.t('alert.yes'), i18next.t('alert.no')],
            defaultId: 0,
            cancelId: 1
        });

        // 4. Execute Actions
        if (response.response === 0) {
            // Open Folders
            for (const folder of folders) {
                await shell.openPath(folder);
            }

            // Open Registry
            if (hasRegistry && registryKeyToOpen) {
                await openRegistryAtKey(registryKeyToOpen);
            }
        }

    } catch (error) {
        console.error('Error browsing local saves:', error);
    }
}

async function deleteLocalSave(resolvedPaths) {
    try {
        // 1. Ask for confirmation
        const response = await dialog.showMessageBox(getMainWin(), {
            type: 'warning',
            title: i18next.t('main.delete_local_save'),
            message: i18next.t('alert.confirm_delete_local_save_message'),
            buttons: [i18next.t('alert.yes'), i18next.t('alert.no')],
            defaultId: 1,
            cancelId: 1
        });

        // 2. Delete paths if confirmed
        if (response.response === 0) {
            let success = true;

            for (const pathObj of resolvedPaths) {
                // Case A: Registry
                if (pathObj.type === 'reg') {
                    if (pathObj.resolved) {
                        const regResult = await deleteRegistryKey(pathObj.resolved);
                        if (!regResult) success = false;
                    }
                }
                // Case B: Files/Folders
                else {
                    const fullPath = pathObj.resolved;
                    if (fullPath && fsOriginal.existsSync(fullPath)) {
                        try {
                            fsOriginal.rmSync(fullPath, { recursive: true, force: true });
                        } catch (err) {
                            console.error(`Failed to delete file path: ${fullPath}`, err);
                            success = false;
                        }
                    }
                }
            }

            if (!success) {
                getMainWin().send('show-alert', 'error', i18next.t('alert.delete_partial_failure'));
            }
            return true;
        }

        return false;

    } catch (error) {
        console.error('Error deleting local saves:', error);
        getMainWin().send('show-alert', 'error', i18next.t('alert.delete_failed'));
        return false;
    }
}

module.exports = { browseLocalSave, deleteLocalSave };
