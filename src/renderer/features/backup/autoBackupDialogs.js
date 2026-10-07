import { showAlert, wrapNumberInput } from '../../shared/utility.js';

export async function showAutoBackupSummary(logs) {
  if (logs && logs.length > 0) {
    const failCount = logs.filter((l) => !l.success).length;
    const summaryMessage = await window.i18n.translate(
      'main.auto_backup_summary',
      {
        total: logs.length,
        failed: failCount,
      },
    );

    if (failCount > 0) {
      const failedDetails = logs
        .filter((l) => !l.success)
        .map((l) => `[${l.timestamp}] ${l.error}`);
      showAlert(
        'modal',
        summaryMessage,
        failedDetails.length === 1 ? failedDetails[0] : [failedDetails],
      );
    } else {
      showAlert('success', summaryMessage);
    }
  } else {
    showAlert('info', await window.i18n.translate('main.auto_backup_disabled'));
  }
}

export async function showAutoBackupModal(wikiId) {
  const modal = document.getElementById('modal-auto-backup');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-auto-backup-title');
  const modalContent = document.getElementById('modal-auto-backup-content');
  const confirmButton = document.getElementById('modal-auto-backup-confirm');
  const closeButton = document.getElementById('modal-auto-backup-close');

  if (!modalOverlay.classList.contains('hidden')) return;

  // Get game title
  const settings = await window.api.invoke('get-settings');
  const backupData = window.backupTableDataMap.get(wikiId);
  const restoreData =
    window.restoreTableDataMap && window.restoreTableDataMap.get(wikiId);
  const gameData = backupData || restoreData;
  let gameTitle = '';
  if (gameData) {
    gameTitle =
      gameData.zh_CN && settings.language === 'zh_CN'
        ? gameData.zh_CN
        : gameData.title;
  }

  const autoBackupState = await window.api.invoke('get-auto-backup-state');
  const isActive = !!autoBackupState[wikiId];
  const status = autoBackupState[wikiId] || null;

  // Set title
  const autoBackupLabel = await window.i18n.translate('main.auto_backup');
  modalTitle.innerHTML = `<i class="fa-solid fa-clock-rotate-left mr-2"></i><span class="text-content">${autoBackupLabel}</span>`;

  // Build content
  const enableLabel = await window.i18n.translate('main.auto_backup_enable');
  const disableLabel = await window.i18n.translate('main.auto_backup_disable');
  const modeIntervalLabel = await window.i18n.translate(
    'main.auto_backup_mode_interval',
  );
  const modeWatcherLabel = await window.i18n.translate(
    'main.auto_backup_mode_watcher',
  );
  const intervalLabel = await window.i18n.translate(
    'main.auto_backup_interval_minutes',
  );
  const modeLabel = await window.i18n.translate('main.auto_backup_mode');
  const statusActiveLabel = await window.i18n.translate(
    'main.auto_backup_status_active',
  );
  const statusInactiveLabel = await window.i18n.translate(
    'main.auto_backup_status_inactive',
  );

  const currentMode = status ? status.mode : 'interval';
  const currentInterval = status ? status.intervalMinutes || 30 : 30;

  let statusHtml = '';
  if (isActive) {
    const modeDisplay =
      status.mode === 'interval'
        ? await window.i18n.translate('main.auto_backup_mode_interval_detail', {
            minutes: status.intervalMinutes,
          })
        : modeWatcherLabel;
    const backupsPerformed = await window.i18n.translate(
      'main.auto_backup_backups_performed',
      { count: status.logCount },
    );
    const failedCount =
      status.failCount > 0
        ? await window.i18n.translate('main.auto_backup_failures', {
            count: status.failCount,
          })
        : '';
    statusHtml = `
            <div class="mb-4 p-3 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg">
                <p class="text-sm text-green-800 dark:text-green-200">
                    <i class="fa-solid fa-circle-check mr-1"></i>
                    <strong>${statusActiveLabel}</strong> — ${modeDisplay}
                </p>
                <p class="auto-backup-performed-count text-sm text-green-700 dark:text-green-300 mt-1">${backupsPerformed}</p>
                <p class="auto-backup-failures-count text-sm text-red-600 dark:text-red-400 mt-1 ${status.failCount > 0 ? '' : 'hidden'}">${failedCount}</p>
            </div>
        `;
  } else {
    statusHtml = `
            <div class="mb-4 p-3 bg-gray-50 dark:bg-gray-600 border border-gray-200 dark:border-gray-500 rounded-lg">
                <p class="text-sm text-gray-600 dark:text-gray-300">
                    <i class="fa-solid fa-circle-xmark mr-1"></i>
                    ${statusInactiveLabel}
                </p>
            </div>
        `;
  }

  modalContent.innerHTML = `
        <p class="auto-backup-game-title text-base font-medium text-gray-900 dark:text-white mb-4"></p>
        ${statusHtml}
        <div id="auto-backup-config" class="${isActive ? 'hidden' : ''}">
            <label class="block mb-2 text-sm font-medium text-gray-900 dark:text-white">${modeLabel}</label>
            <div class="flex flex-col gap-2 mb-4">
                <label class="flex items-center cursor-pointer">
                    <input type="radio" name="auto-backup-mode" value="interval" ${currentMode === 'interval' ? 'checked' : ''}
                        class="w-4 h-4 text-blue-600 dark:text-blue-500 bg-gray-100 dark:bg-gray-700 dark:border-gray-600">
                    <span class="ms-2 text-sm text-gray-900 dark:text-gray-300">${modeIntervalLabel}</span>
                </label>
                <label class="flex items-center cursor-pointer">
                    <input type="radio" name="auto-backup-mode" value="watcher" ${currentMode === 'watcher' ? 'checked' : ''}
                        class="w-4 h-4 text-blue-600 dark:text-blue-500 bg-gray-100 dark:bg-gray-700 dark:border-gray-600">
                    <span class="ms-2 text-sm text-gray-900 dark:text-gray-300">${modeWatcherLabel}</span>
                </label>
            </div>

            <div id="auto-backup-interval-config" class="${currentMode === 'watcher' ? 'hidden' : ''}">
                <label class="block mb-1 text-sm font-medium text-gray-900 dark:text-white">${intervalLabel}</label>
                <input type="number" id="auto-backup-interval" value="${currentInterval}" min="1"
                    class="mb-4 bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:outline-hidden block w-full p-2.5 dark:bg-gray-600 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white" />
            </div>
        </div>
    `;

  modalContent.querySelector('.auto-backup-game-title').textContent = gameTitle;

  // Toggle interval config visibility based on mode selection
  modalContent
    .querySelectorAll('input[name="auto-backup-mode"]')
    .forEach((radio) => {
      radio.addEventListener('change', () => {
        const intervalConfig = document.getElementById(
          'auto-backup-interval-config',
        );
        if (radio.value === 'watcher') {
          intervalConfig.classList.add('hidden');
        } else {
          intervalConfig.classList.remove('hidden');
        }
      });
    });

  // Wrap interval input with custom controls
  const intervalInput = document.getElementById('auto-backup-interval');
  if (intervalInput) {
    wrapNumberInput(intervalInput);
  }

  // Update confirm button text
  if (isActive) {
    confirmButton.innerHTML = `<span class="text-content">${disableLabel}</span>`;
    confirmButton.className = confirmButton.className
      .replace(/bg-blue-700 hover:bg-blue-800/, 'bg-red-600 hover:bg-red-700')
      .replace(
        /dark:bg-blue-600 dark:hover:bg-blue-700/,
        'dark:bg-red-700 dark:hover:bg-red-600',
      );
  } else {
    confirmButton.innerHTML = `<span class="text-content">${enableLabel}</span>`;
    confirmButton.className = confirmButton.className
      .replace(/bg-red-600 hover:bg-red-700/, 'bg-blue-700 hover:bg-blue-800')
      .replace(
        /dark:bg-red-700 dark:hover:bg-red-600/,
        'dark:bg-blue-600 dark:hover:bg-blue-700',
      );
  }

  const handleClose = () => {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalOverlay.classList.add('hidden');
  };

  const handleConfirm = async () => {
    if (isActive) {
      // Disable auto backup and show summary
      const logs = await window.api.invoke('stop-auto-backup', wikiId);
      handleClose();
      await showAutoBackupSummary(logs);
    } else {
      // Enable auto backup
      const mode = modalContent.querySelector(
        'input[name="auto-backup-mode"]:checked',
      ).value;
      const intervalMinutes =
        parseInt(document.getElementById('auto-backup-interval').value, 10) ||
        30;
      await window.api.invoke(
        'start-auto-backup',
        wikiId,
        mode,
        intervalMinutes,
      );
      handleClose();
      showAlert(
        'success',
        await window.i18n.translate('main.auto_backup_enabled'),
      );
    }
  };

  // Clear previous listeners by cloning
  const newCloseButton = closeButton.cloneNode(true);
  closeButton.parentNode.replaceChild(newCloseButton, closeButton);
  newCloseButton.addEventListener('click', handleClose);

  const newConfirmButton = confirmButton.cloneNode(true);
  confirmButton.parentNode.replaceChild(newConfirmButton, confirmButton);
  newConfirmButton.addEventListener('click', handleConfirm);

  // Tagged with its game so live auto-backup updates can find it while open
  modal.dataset.wikiId = String(wikiId);

  modal.classList.add('flex');
  modal.classList.remove('hidden');
  modalOverlay.classList.remove('hidden');
}

// Updates the open modal's counts; a no-op unless it is open for this game
export async function refreshAutoBackupModalStatus(wikiId) {
  const modal = document.getElementById('modal-auto-backup');
  if (!modal || modal.classList.contains('hidden')) return;
  if (modal.dataset.wikiId !== String(wikiId)) return;

  const state = await window.api.invoke('get-auto-backup-state');
  const status = state[wikiId];
  if (!status) return; // no longer active

  const modalContent = document.getElementById('modal-auto-backup-content');
  const countEl = modalContent.querySelector('.auto-backup-performed-count');
  if (countEl) {
    countEl.textContent = await window.i18n.translate(
      'main.auto_backup_backups_performed',
      { count: status.logCount },
    );
  }

  const failuresEl = modalContent.querySelector('.auto-backup-failures-count');
  if (failuresEl) {
    if (status.failCount > 0) {
      failuresEl.textContent = await window.i18n.translate(
        'main.auto_backup_failures',
        { count: status.failCount },
      );
      failuresEl.classList.remove('hidden');
    } else {
      failuresEl.classList.add('hidden');
    }
  }
}

// ======================================================================
// Hidden games
// ======================================================================
