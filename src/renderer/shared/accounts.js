import { showAlert } from './alerts.js';
import { updateTranslations } from './i18n.js';
export function showAccountModal() {
    const modal = document.getElementById('modal-info');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalTitleElement = document.getElementById('modal-info-title');
    const modalContentElement = document.getElementById('modal-info-content');
    const closeButton = document.getElementById('modal-info-close');
    const confirmButton = document.getElementById('modal-info-confirm');

    if (!modalOverlay.classList.contains('hidden')) return;

    Promise.all([
        window.api.invoke('get-account-data'),
        window.api.invoke('get-settings')
    ]).then(([accountData, settings]) => {
        modalTitleElement.setAttribute('data-i18n', 'main.view_account_ids');
        const titleSpan = document.createElement('span');
        titleSpan.className = 'text-content';
        modalTitleElement.appendChild(titleSpan);

        const isBackupAllAccounts = settings.backupAllAccounts || false;

        let contentHTML = `
            <div class="space-y-4">
                <div class="space-y-2">
                    <h4 class="font-semibold text-gray-900 dark:text-white text-content" data-i18n="alert.detected_accounts"></h4>
                    <div class="bg-gray-50 dark:bg-gray-600 p-4 rounded-lg space-y-2">
        `;

        if (accountData && Object.keys(accountData).length > 0) {
            for (const [platform, id] of Object.entries(accountData)) {
                if (id && id !== 'N/A' && id !== null) {
                    const platformKeys = {
                        steamId64: 'alert.steam_64_bit_id',
                        steamAccountId: 'alert.steam_account_id',
                        ubisoftAccountId: 'alert.ubisoft_account_id',
                        epicAccountId: 'alert.epic_account_id',
                        xboxAccountId: 'alert.xbox_account_id',
                        rockstarAccountId: 'alert.rockstar_account_id'
                    };
                    contentHTML += `
                        <div class="flex justify-between items-center text-sm">
                            <span class="text-gray-700 dark:text-gray-300 text-content" data-i18n="${platformKeys[platform] || platform}"></span>
                            <code class="bg-gray-200 dark:bg-gray-700 px-2 py-1 rounded text-gray-900 dark:text-gray-100">${id}</code>
                        </div>
                    `;
                }
            }
        } else {
            contentHTML += `<p class="text-gray-600 dark:text-gray-400 text-content" data-i18n="alert.no_accounts_detected"></p>`;
        }

        contentHTML += `
                    </div>
                </div>

                <div class="border-t border-gray-300 dark:border-gray-600 pt-4">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-3 text-content" data-i18n="alert.backup_scope"></h4>
                    <div class="flex flex-col gap-2">
                        <label class="flex items-center cursor-pointer">
                            <input id="backup-scope-current" type="radio" name="backup-scope" 
                                ${!isBackupAllAccounts ? 'checked' : ''}
                                class="w-4 h-4 text-blue-600 dark:text-blue-500 bg-gray-100 dark:bg-gray-700 dark:border-gray-600">
                            <span class="ms-2 text-sm font-medium text-gray-900 dark:text-gray-300 text-content" data-i18n="alert.current_account_only"></span>
                        </label>

                        <label class="flex items-center cursor-pointer">
                            <input id="backup-scope-all" type="radio" name="backup-scope" 
                                ${isBackupAllAccounts ? 'checked' : ''}
                                class="w-4 h-4 text-blue-600 dark:text-blue-500 bg-gray-100 dark:bg-gray-700 dark:border-gray-600">
                            <span class="ms-2 text-sm font-medium text-gray-900 dark:text-gray-300 text-content" data-i18n="alert.all_accounts"></span>
                        </label>
                    </div>
                </div>

                <div class="bg-blue-50 dark:bg-blue-900 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mt-4">
                    <p class="text-sm text-blue-800 dark:text-blue-200">
                        <strong data-i18n="alert.note" class="text-content">Note: </strong><span class="text-content" data-i18n="alert.account_backup_note"></span>
                    </p>
                </div>
            </div>
        `;

        modalContentElement.innerHTML = contentHTML;

        const handleClose = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modalOverlay.classList.add('hidden');
        };

        const handleConfirm = async () => {
            const isAllAccountsSelected = document.getElementById('backup-scope-all').checked;
            if (isAllAccountsSelected === isBackupAllAccounts) {
                handleClose();
                return;
            }

            const saved = await window.api.invoke('save-settings', 'backupAllAccounts', isAllAccountsSelected);
            if (!saved) {
                showAlert('warning', await window.i18n.translate('settings.save-settings-error'));
                return;
            }

            window.api.send('update-backup-table');
            handleClose();
        };

        confirmButton.setAttribute('data-i18n', 'alert.confirm');
        confirmButton.className += ' text-content';

        // Clear previous listeners
        const newCloseButton = closeButton.cloneNode(true);
        closeButton.parentNode.replaceChild(newCloseButton, closeButton);
        document.getElementById('modal-info-close').addEventListener('click', handleClose);

        const newConfirmButton = confirmButton.cloneNode(true);
        confirmButton.parentNode.replaceChild(newConfirmButton, confirmButton);
        document.getElementById('modal-info-confirm').addEventListener('click', handleConfirm);

        updateTranslations(modal);

        modal.classList.add('flex');
        modal.classList.remove('hidden');
        modalOverlay.classList.remove('hidden');
    }).catch(err => {
        console.error('Error fetching account data:', err);
        modalTitleElement.textContent = 'Error';
        modalContentElement.textContent = 'Failed to load account information.';
        modal.classList.add('flex');
        modal.classList.remove('hidden');
        modalOverlay.classList.remove('hidden');
    });
}

// ======================================================================
// Inputs and guards
// ======================================================================
// Replaces the native spinners with styled chevron buttons
