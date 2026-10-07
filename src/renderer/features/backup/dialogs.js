import { showAlert, updateProgress, operationStartCheck } from '../../shared/utility.js';
import { setIcon, formatSize, addOrUpdateTableRow, removeTableRow, updateSelectedCountAndSize } from '../../shared/tables.js';
import { snapshotDate, snapshotTime } from '../cloud/presentation.js';
import { element, uploadLocalSnapshot } from '../cloud/shared.js';

function updateBackupDateDisplay(backupDateDisplay, backupDate, customName, isPermanent) {
    const formattedDate = snapshotDate({ createdAt: backupDateDisplay.closest('tr').dataset.createdAt });
    backupDateDisplay.replaceChildren();
    if (isPermanent) {
        backupDateDisplay.append(element('i', null, 'fa-solid fa-star text-yellow-500 mr-2'));
        if (customName) {
            const detail = element('div', null, 'flex flex-col');
            detail.append(element('span', customName, 'backup-custom-name font-medium'), element('span', formattedDate, 'text-xs text-gray-500 dark:text-gray-400'));
            backupDateDisplay.append(detail);
        } else {
            backupDateDisplay.append(element('span', formattedDate, 'backup-date-text'));
        }
        const rename = element('button', null, 'rename-backup-btn text-gray-400 hover:text-blue-500 transition-colors duration-150 ml-2');
        rename.type = 'button'; rename.dataset.backupDate = backupDate;
        rename.append(element('i', null, 'fa-solid fa-pencil'));
        backupDateDisplay.append(rename);
    } else {
        backupDateDisplay.append(element('span', formattedDate, 'backup-date-text'));
    }
}

// Helper function for Backup Management Modal to attach rename button listener
function attachRenameButtonListener(renameBtn) {
    const row = renameBtn.closest('tr');
    renameBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const renameMode = row.querySelector('.rename-mode');
        const backupDateDisplay = row.querySelector('.backup-date-display');
        const nameInput = row.querySelector('.backup-name-input');
        const currentCustomName = row.getAttribute('data-custom-name');

        renameMode.classList.remove('hidden');
        renameMode.classList.add('flex');
        backupDateDisplay.classList.add('hidden');
        nameInput.value = currentCustomName || '';
        nameInput.focus();
        nameInput.select();
    });
}

export async function showManageBackupsModal(wikiId) {
    // The only view that shows every backup's size, so the only one asking for them all
    const gamesList = await window.api.invoke('fetch-restore-table-data', wikiId, true);

    // Falls back to backupTableDataMap when the game has no backups yet
    const gameData = gamesList && gamesList.length > 0
        ? gamesList[0]
        : { backups: [], latest_backup: '-', title: '', zh_CN: '' };

    // If no restore data, use backupTableDataMap for game info
    if (!gamesList || gamesList.length === 0) {
        const backupData = window.backupTableDataMap.get(wikiId);
        if (backupData) {
            gameData.title = backupData.title;
            gameData.zh_CN = backupData.zh_CN;
        }
    }

    const modal = document.getElementById('modal-manage-backups');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalTitle = document.getElementById('modal-manage-backups-title');
    const headerInfo = document.getElementById('modal-manage-backups-header-info');
    const modalContent = document.getElementById('modal-manage-backups-content');

    // Set title
    let gameTitle = gameData.title;
    await window.api.invoke('get-settings').then((settings) => {
        if (gameData.zh_CN && settings.language === 'zh_CN') {
            gameTitle = gameData.zh_CN;
        }
    });
    const backupCount = gameData.backups.length;
    const latestBackup = gameData.backups.length ? snapshotDate([...gameData.backups].sort((a, b) => snapshotTime(b) - snapshotTime(a))[0]) : '—';
    modalTitle.textContent = gameTitle;

    // Create header info with translations
    const newestBackupLabel = await window.i18n.translate('main.newest_backup_time');
    const backupCountLabel = await window.i18n.translate('main.backup_count');
    headerInfo.innerHTML = `
        <p><span class="font-medium">${newestBackupLabel}:</span> <span class="newest-backup-value">${latestBackup}</span></p>
        <p><span class="font-medium">${backupCountLabel}:</span> <span class="backup-count-value">${backupCount}</span></p>
    `;

    const backupTimeLabel = await window.i18n.translate('main.backup_time');
    const backupSizeLabel = await window.i18n.translate('main.backup_size');
    const actionLabel = await window.i18n.translate('main.action');
    const restoreLabel = await window.i18n.translate('main.restore');
    const deleteLabel = await window.i18n.translate('main.delete');
    const makePermanentLabel = await window.i18n.translate('main.make_permanent');
    const removePermanentLabel = await window.i18n.translate('main.remove_permanent');
    const enterBackupNameLabel = await window.i18n.translate('main.enter_backup_name');
    const openBackupFolderLabel = await window.i18n.translate('main.open_backup_folder');
    const browseLocalSaveLabel = await window.i18n.translate('main.browse_local_save');
    const deleteLocalSaveLabel = await window.i18n.translate('main.delete_local_save');

    const rowsHtml = gameData.backups
        .sort((a, b) => {
            // Sort by is_permanent (true first), then by date
            if (a.is_permanent !== b.is_permanent) {
                return b.is_permanent - a.is_permanent;
            }
            return snapshotTime(b) - snapshotTime(a);
        })
        .map(backup => {
            const backupSize = formatSize(backup.backup_size);
            return `<tr class="bg-white border-b dark:bg-[#2d3748] dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-600">
                <td class="px-4 py-3 font-medium text-gray-900 dark:text-white">
                    <div class="flex items-center">
                        <div class="rename-mode hidden items-center bg-white dark:bg-gray-700 rounded-md border border-gray-300 dark:border-gray-600">
                            <input type="text" class="backup-name-input pl-3 py-2 flex-1 min-w-0 bg-transparent border-0 text-gray-900 text-sm focus:outline-none dark:text-white placeholder-gray-500 dark:placeholder-gray-400" placeholder="${enterBackupNameLabel}" />
                            <button type="button" class="confirm-rename-btn px-3 py-2 text-green-500 hover:text-green-600 transition-colors duration-150">
                                <i class="fa-solid fa-check"></i>
                            </button>
                        </div>
                        <div class="backup-date-display flex items-center">
                        </div>
                    </div>
                </td>
                <td class="px-6 py-3">${backupSize}</td>
                <td class="px-6 py-3 text-center">
                    <div class="flex justify-center gap-2">
                        <button type="button" class="restore-backup-btn inline-flex items-center px-3 py-1 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors duration-150 dark:bg-blue-700 dark:hover:bg-blue-600">
                            <i class="fa-solid fa-arrow-left mr-1"></i>
                            ${restoreLabel}
                        </button>
                        <button type="button" class="permanent-backup-btn inline-flex items-center px-3 py-1 text-sm font-medium text-white bg-yellow-500 hover:bg-yellow-600 rounded-md transition-colors duration-150 dark:bg-yellow-600 dark:hover:bg-yellow-500" data-is-permanent="${backup.is_permanent}">
                            <i class="fa-solid fa-star mr-1"></i>
                            ${backup.is_permanent ? removePermanentLabel : makePermanentLabel}
                        </button>
                        <button type="button" class="delete-backup-btn inline-flex items-center px-3 py-1 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors duration-150 dark:bg-red-700 dark:hover:bg-red-600">
                            <i class="fa-solid fa-trash mr-1"></i>
                            ${deleteLabel}
                        </button>
                    </div>
                </td>
            </tr>`;
        })
        .join('');

    const tableHtml = `
        <div class="overflow-x-auto">
            <table class="w-full text-sm text-left rtl:text-right text-gray-500 dark:text-gray-400">
                <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-800 dark:text-gray-200 rounded-t-lg">
                    <tr>
                        <th scope="col" class="px-4 py-3 rounded-tl-lg">${backupTimeLabel}</th>
                        <th scope="col" class="px-6 py-3">${backupSizeLabel}</th>
                        <th scope="col" class="px-6 py-3 text-center rounded-tr-lg">${actionLabel}</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;

    const footerButtonsHtml = `
        <div class="mt-4 flex flex-wrap items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-4">
            <button type="button" id="modal-open-backup-folder" class="inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 dark:bg-gray-700 dark:text-white dark:border-gray-600 dark:hover:bg-gray-600">
                <i class="fa-solid fa-folder-open mr-2"></i>
                ${openBackupFolderLabel}
            </button>

            <div class="flex gap-3">
                <button type="button" id="modal-browse-local-save" class="inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 dark:bg-gray-700 dark:text-white dark:border-gray-600 dark:hover:bg-gray-600">
                    <i class="fa-solid fa-folder-tree mr-2"></i>
                    ${browseLocalSaveLabel}
                </button>
                <button type="button" id="modal-delete-local-save" class="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-70 dark:bg-red-700 dark:hover:bg-red-600">
                    <i class="fa-solid fa-trash-can mr-2"></i>
                    ${deleteLocalSaveLabel}
                </button>
            </div>
        </div>
    `;

    modalContent.innerHTML = tableHtml + footerButtonsHtml;
    for (const [index, row] of Array.from(modalContent.querySelectorAll('tbody tr')).entries()) {
        const backup = gameData.backups[index];
        row.dataset.customName = backup.custom_name || '';
        row.dataset.createdAt = backup.createdAt || backup.backupConfig?.createdAt || '';
        for (const control of row.querySelectorAll('button')) control.dataset.backupDate = backup.date;
        updateBackupDateDisplay(row.querySelector('.backup-date-display'), backup.date, backup.custom_name, backup.is_permanent);
        const upload = element('button', await window.i18n.translate('cloud.upload'), 'cloud-button');
        upload.type = 'button';
        upload.addEventListener('click', async () => {
            try { await uploadLocalSnapshot(wikiId, backup.date); }
            catch (error) {
                const status = element('p', error.message, 'cloud-error');
                status.setAttribute('role', 'alert');
                row.querySelector('td:last-child').append(status);
            }
        });
        row.querySelector('td:last-child > div').append(upload);
    }

    // Add event listeners to 'open backup folder' button
    document.getElementById('modal-open-backup-folder').addEventListener('click', () => {
        window.api.send('open-backup-folder', wikiId);
    });

    // Add event listeners to 'browse local save' button
    document.getElementById('modal-browse-local-save').addEventListener('click', async () => {
        // Check 1: the backup tab has finished loading
        const backupLoaderContainer = document.getElementById('backup-loading');
        const isBackupLoading = backupLoaderContainer && !backupLoaderContainer.classList.contains('hidden') && backupLoaderContainer.querySelector('[data-loader-active="true"]');
        if (isBackupLoading) {
            showAlert('warning', await window.i18n.translate('alert.wait_for_backup_loading'));
            return;
        }

        // Check 2: make sure local save data exists
        const gameData = window.backupTableDataMap.get(wikiId);
        const resolvedPaths = gameData?.resolved_paths;

        if (!gameData || !resolvedPaths || resolvedPaths.length === 0) {
            showAlert('warning', await window.i18n.translate('alert.no_local_save_found'));
            return;
        }

        window.api.send('browse-local-save', resolvedPaths);
    });

    // Add event listeners to 'delete local save' button
    document.getElementById('modal-delete-local-save').addEventListener('click', async () => {
        const backupLoaderContainer = document.getElementById('backup-loading');
        const isBackupLoading = backupLoaderContainer && !backupLoaderContainer.classList.contains('hidden') && backupLoaderContainer.querySelector('[data-loader-active="true"]');
        if (isBackupLoading) {
            showAlert('warning', await window.i18n.translate('alert.wait_for_backup_loading'));
            return;
        }

        const gameData = window.backupTableDataMap.get(wikiId);
        const resolvedPaths = gameData?.resolved_paths;

        if (!gameData || !resolvedPaths || resolvedPaths.length === 0) {
            showAlert('warning', await window.i18n.translate('alert.no_local_save_found'));
            return;
        }

        const success = await window.api.invoke('confirm-delete-local-save', resolvedPaths);
        if (success) {
            removeTableRow('backup', wikiId);
            showAlert('success', await window.i18n.translate('alert.local_save_deleted'));
        }
    });

    // Add event listeners to restore buttons
    modalContent.querySelectorAll('.restore-backup-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            closeManageBackupsModal();
            const backupDate = btn.dataset.backupDate;
            await restoreBackupInstance(backupDate, gameData);
        });
    });

    // Add event listeners to permanent buttons
    modalContent.querySelectorAll('.permanent-backup-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const backupDate = btn.dataset.backupDate;
            const isPermanent = btn.dataset.isPermanent === 'true';
            const newIsPermanent = !isPermanent;

            const success = await window.api.invoke('update-backup-info', wikiId, backupDate, 'is_permanent', newIsPermanent);

            if (success) {
                const row = btn.closest('tr');
                const backupDateDisplay = row.querySelector('.backup-date-display');
                const customName = row.getAttribute('data-custom-name');

                // Update star icon/custom name on modal
                if (newIsPermanent) {
                    btn.dataset.isPermanent = 'true';
                    btn.innerHTML = `<i class="fa-solid fa-star mr-1"></i>${removePermanentLabel}`;

                    updateBackupDateDisplay(backupDateDisplay, backupDate, customName, true);

                    const renameBtn = backupDateDisplay.querySelector('.rename-backup-btn');
                    if (renameBtn) {
                        attachRenameButtonListener(renameBtn);
                    }
                } else {
                    btn.dataset.isPermanent = 'false';
                    btn.innerHTML = `<i class="fa-solid fa-star mr-1"></i>${makePermanentLabel}`;

                    updateBackupDateDisplay(backupDateDisplay, backupDate, customName, false);
                }

                // Show star icon on main tables if ANY permanent backups exist
                const hasAnyPermanentBackup = gameData.backups.some(backup => {
                    const btn = modalContent.querySelector(`.permanent-backup-btn[data-backup-date="${backup.date}"]`);
                    return btn && btn.dataset.isPermanent === 'true';
                });
                const backupTableRow = document.querySelector(`#backup tbody tr[data-wiki-id="${wikiId}"]`);
                const restoreTableRow = document.querySelector(`#restore tbody tr[data-wiki-id="${wikiId}"]`);
                if (backupTableRow) {
                    setIcon(backupTableRow, 'star', hasAnyPermanentBackup);
                }
                if (restoreTableRow) {
                    setIcon(restoreTableRow, 'star', hasAnyPermanentBackup);
                }
                // Keep restoreTableDataMap current so the backup tab stars the right rows
                const restoreGameData = window.restoreTableDataMap.get(wikiId);
                if (restoreGameData) {
                    const backupToUpdate = restoreGameData.backups.find(b => b.date === backupDate);
                    if (backupToUpdate) {
                        backupToUpdate.is_permanent = newIsPermanent;
                    }
                }

                // Re-sort table with permanent backups on top
                const tbody = modalContent.querySelector('tbody');
                const rows = Array.from(tbody.querySelectorAll('tr'));
                rows.sort((a, b) => {
                    const aIsPermanent = a.querySelector('.permanent-backup-btn').dataset.isPermanent === 'true';
                    const bIsPermanent = b.querySelector('.permanent-backup-btn').dataset.isPermanent === 'true';
                    if (aIsPermanent !== bIsPermanent) {
                        return bIsPermanent - aIsPermanent;
                    }
                    // Then sort by date (newest first)
                    return snapshotTime({ createdAt: b.dataset.createdAt }) - snapshotTime({ createdAt: a.dataset.createdAt });
                });
                rows.forEach(row => tbody.appendChild(row));
            }
        });
    });

    // Add event listeners to delete backup buttons
    modalContent.querySelectorAll('.delete-backup-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const backupDate = btn.dataset.backupDate;
            const row = btn.closest('tr');
            const success = await window.api.invoke('confirm-delete-backup', wikiId, backupDate);

            if (success) {
                row.remove();
                const countElement = headerInfo.querySelector('.backup-count-value');
                const currentCount = parseInt(countElement.textContent);
                const newCount = currentCount - 1;
                countElement.textContent = newCount;

                // Update newest backup date in modal header
                const newestBackupElement = headerInfo.querySelector('.newest-backup-value');
                const remaining = Array.from(modalContent.querySelectorAll('tbody tr'))
                    .map(item => ({ createdAt: item.dataset.createdAt })).sort((a, b) => snapshotTime(b) - snapshotTime(a));
                newestBackupElement.textContent = remaining.length ? snapshotDate(remaining[0]) : '—';

                if (newCount === 0) {
                    // If all backups are deleted, remove the row from the restore table
                    removeTableRow('restore', wikiId);
                } else {
                    // Update restore tab row
                    await addOrUpdateTableRow('restore', wikiId);
                    updateSelectedCountAndSize('restore');
                }

                // Update backup tab row
                await addOrUpdateTableRow('backup', wikiId);
                updateSelectedCountAndSize('backup');
            }
        });
    });

    // Add event listeners to rename backup buttons
    modalContent.querySelectorAll('.rename-backup-btn').forEach(btn => {
        attachRenameButtonListener(btn);
    });

    // Add event listeners to confirm rename backup buttons
    modalContent.querySelectorAll('.confirm-rename-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const row = btn.closest('tr');
            const backupDate = row.querySelector('.permanent-backup-btn').dataset.backupDate;
            const nameInput = row.querySelector('.backup-name-input');
            const newName = nameInput.value.trim();

            const success = await window.api.invoke('update-backup-info', wikiId, backupDate, 'custom_name', newName);

            if (success) {
                row.setAttribute('data-custom-name', newName);
                const renameMode = row.querySelector('.rename-mode');
                const backupDateDisplay = row.querySelector('.backup-date-display');
                updateBackupDateDisplay(backupDateDisplay, backupDate, newName, true);

                renameMode.classList.add('hidden');
                renameMode.classList.remove('flex');
                backupDateDisplay.classList.remove('hidden');

                // Update restoreTableDataMap with custom name
                const restoreGameData = window.restoreTableDataMap && window.restoreTableDataMap.get(wikiId);
                if (restoreGameData) {
                    const backupToUpdate = restoreGameData.backups.find(b => b.date === backupDate);
                    if (backupToUpdate) {
                        backupToUpdate.custom_name = newName;
                    }
                }

                // Re-attach rename button event listener
                const newRenameBtn = backupDateDisplay.querySelector('.rename-backup-btn');
                if (newRenameBtn) {
                    attachRenameButtonListener(newRenameBtn);
                }
            }
        });
    });

    // Add keydown listener to rename input fields to trigger confirm on Enter
    modalContent.querySelectorAll('.backup-name-input').forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const confirmBtn = input.closest('.rename-mode').querySelector('.confirm-rename-btn');
                if (confirmBtn) {
                    confirmBtn.click();
                }
            }
        });
    });

    // Show modal
    modal.classList.add('flex');
    modal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');

    // Close button handler
    document.getElementById('modal-manage-backups-close').onclick = closeManageBackupsModal;
}

function closeManageBackupsModal() {
    const modal = document.getElementById('modal-manage-backups');
    const modalOverlay = document.getElementById('modal-overlay');

    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalOverlay.classList.add('hidden');
}

// ======================================================================
// Auto backup
// ======================================================================
// `logs` is what stop-auto-backup returned, empty or null when there was nothing
async function restoreBackupInstance(backupDate, gameData) {
    const start = await operationStartCheck('restore');

    if (start) {
        window.api.send('update-status', 'restoring', true);
        const restoreButton = document.getElementById('restore-button');
        restoreButton.disabled = true;
        restoreButton.classList.add('cursor-not-allowed');
        const restoreProgressId = 'restore-progress';
        const restoreProgressTitle = await window.api.invoke('translate', 'main.restore_in_progress');
        updateProgress(restoreProgressId, restoreProgressTitle, 'start');

        // Find the specific backup instance
        const backupInstance = gameData.backups.find(b => b.date === backupDate);
        // Create a game object with just this backup instance
        const gameObjForRestore = { ...gameData, backups: [backupInstance] };
        const { action, error } = await window.api.invoke('restore-game', gameObjForRestore, null);

        const restoreFailed = error ? 1 : 0;
        updateProgress(restoreProgressId, restoreProgressTitle, 'end');
        document.querySelector('#restore-tab').click();
        window.showRestoreSummary(1, restoreFailed, error, backupInstance.backup_size);
        document.querySelector('#restore-summary-done').classList.remove('hidden');
        restoreButton.disabled = false;
        restoreButton.classList.remove('cursor-not-allowed');
        window.api.send('update-status', 'restoring', false);

        // Update backup tab entry in background
        const wikiId = gameData.wiki_page_id;
        (async () => {
            window.api.send('update-status', 'updating_backup', true);
            await addOrUpdateTableRow('backup', wikiId);
            window.api.send('update-status', 'updating_backup', false);
        })();
    }
}
