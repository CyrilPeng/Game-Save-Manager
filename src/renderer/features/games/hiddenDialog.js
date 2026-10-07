import { showAlert } from '../../shared/utility.js';
import { addOrUpdateTableRow, updateSelectedCountAndSize } from '../../shared/tables.js';



export async function showHiddenGamesModal() {
    const modal = document.getElementById('modal-hidden-games');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalContent = document.getElementById('modal-hidden-games-content');
    const closeButton = document.getElementById('modal-hidden-games-close');

    if (!modalOverlay.classList.contains('hidden')) return;

    const settings = await window.api.invoke('get-settings');
    const hiddenWikiIds = (settings.hiddenGames || []).map(String);

    const renderContent = async () => {
        if (hiddenWikiIds.length === 0) {
            const emptyLabel = await window.i18n.translate('main.no_hidden_games');
            modalContent.innerHTML = `<p class="text-sm text-gray-600 dark:text-gray-400 text-center py-4">${emptyLabel}</p>`;
            return;
        }

        const noBackupsText = await window.i18n.translate('main.no_backups');

        // Names come from the database (works even for uninstalled / no-backup games)
        const titles = await window.api.invoke('get-game-titles', hiddenWikiIds);
        const titleMap = new Map(titles.map(t => [t.wiki_page_id.toString(), t]));

        // Backup count and latest backup date reuse the restore-data helper
        const gamesForSort = await Promise.all(hiddenWikiIds.map(async (wikiId) => {
            const nameInfo = titleMap.get(wikiId);
            let displayTitle = nameInfo
                ? ((nameInfo.zh_CN && settings.language === 'zh_CN') ? nameInfo.zh_CN : nameInfo.title)
                : null;
            let backupCount = 0;
            let latestBackup = noBackupsText;

            const restoreGames = await window.api.invoke('fetch-restore-table-data', wikiId);
            if (restoreGames && restoreGames.length > 0) {
                backupCount = restoreGames[0].backups.length;
                latestBackup = restoreGames[0].latest_backup;
                if (!displayTitle) {
                    displayTitle = (restoreGames[0].zh_CN && settings.language === 'zh_CN')
                        ? restoreGames[0].zh_CN
                        : restoreGames[0].title;
                }
            }

            displayTitle = displayTitle || wikiId;
            return { wikiId, displayTitle, titleToSort: displayTitle, backupCount, latestBackup };
        }));
        const sortedGames = await window.api.invoke('sort-games', gamesForSort);

        const gameNameLabel = await window.i18n.translate('main.game_name');
        const backupCountLabel = await window.i18n.translate('main.backup_count');
        const newestBackupLabel = await window.i18n.translate('main.newest_backup_time');
        const actionLabel = await window.i18n.translate('main.action');
        const unhideLabel = await window.i18n.translate('main.unhide');

        const rowsHtml = sortedGames.map(game => `
            <tr class="bg-white border-b dark:bg-[#2d3748] dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-600">
                <td class="hidden-game-title px-4 py-3 font-medium wrap-break-word text-gray-900 dark:text-white"></td>
                <td class="px-4 py-3 whitespace-nowrap">${game.backupCount}</td>
                <td class="hidden-game-date px-4 py-3 whitespace-nowrap"></td>
                <td class="px-4 py-3 text-center">
                    <button type="button" class="unhide-game-btn inline-flex items-center whitespace-nowrap px-3 py-1 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors duration-150 dark:bg-blue-700 dark:hover:bg-blue-600">
                        <i class="fa-solid fa-eye mr-1"></i>
                        ${unhideLabel}
                    </button>
                </td>
            </tr>
        `).join('');

        modalContent.innerHTML = `
            <div class="overflow-x-auto">
                <table class="w-full table-fixed text-sm text-left rtl:text-right text-gray-500 dark:text-gray-400">
                    <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-800 dark:text-gray-200">
                        <tr>
                            <th scope="col" class="px-4 py-3 rounded-tl-lg">${gameNameLabel}</th>
                            <th scope="col" class="px-4 py-3 w-44 whitespace-nowrap">${backupCountLabel}</th>
                            <th scope="col" class="px-4 py-3 w-44 whitespace-nowrap">${newestBackupLabel}</th>
                            <th scope="col" class="px-4 py-3 w-36 whitespace-nowrap text-center rounded-tr-lg">${actionLabel}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        `;

        for (const [index, row] of Array.from(modalContent.querySelectorAll('tbody tr')).entries()) {
            row.dataset.wikiId = sortedGames[index].wikiId;
            row.querySelector('.hidden-game-title').textContent = sortedGames[index].displayTitle;
            row.querySelector('.hidden-game-date').textContent = sortedGames[index].latestBackup;
            row.querySelector('.unhide-game-btn').dataset.id = sortedGames[index].wikiId;
        }
        modalContent.querySelectorAll('.unhide-game-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const wikiId = btn.dataset.id;
                const idx = hiddenWikiIds.indexOf(wikiId);
                if (idx !== -1) {
                    hiddenWikiIds.splice(idx, 1);
                }
                const saved = await window.api.invoke('save-settings', 'hiddenGames', [...hiddenWikiIds]);
                if (!saved) {
                    showAlert('warning', await window.i18n.translate('settings.save-settings-error'));
                    return;
                }

                // Restore first: the backup row reads permanent state from restoreTableDataMap
                await addOrUpdateTableRow('restore', wikiId);
                await addOrUpdateTableRow('backup', wikiId);
                updateSelectedCountAndSize('backup');
                updateSelectedCountAndSize('restore');

                await renderContent();
            });
        });
    };

    await renderContent();

    const handleClose = () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modalOverlay.classList.add('hidden');
    };

    // Clear previous listeners by cloning
    const newCloseButton = closeButton.cloneNode(true);
    closeButton.parentNode.replaceChild(newCloseButton, closeButton);
    newCloseButton.addEventListener('click', handleClose);

    modal.classList.add('flex');
    modal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');
}

// ======================================================================
// Restoring one backup
// ======================================================================
