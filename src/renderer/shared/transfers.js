import { showAlert } from './alerts.js';
import { operationStartCheck } from './operations.js';
import { wrapNumberInput } from './inputs.js';
export function showExportModal() {
    const modal = document.getElementById('modal-export');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalExportCountInput = document.getElementById('modal-export-count');
    const modalExportPathInput = document.getElementById('modal-export-path');
    const modalExportPathSelectButton = document.getElementById('modal-export-select-path');

    if (!modalOverlay.classList.contains('hidden')) return;

    wrapNumberInput(modalExportCountInput);

    window.api.invoke('get-settings').then((settings) => {
        if (settings) {
            modalExportCountInput.max = settings.maxBackups;
            modalExportPathInput.value = settings.exportPath;
        }
    });

    if (!modal.dataset.listenerAdded) {
        modalExportCountInput.addEventListener('input', () => {
            const min = parseInt(modalExportCountInput.min, 10);
            const max = parseInt(modalExportCountInput.max, 10);
            let value = parseInt(modalExportCountInput.value, 10);

            if (isNaN(value) || value < 1) {
                modalExportCountInput.value = min;
            } else if (value > max) {
                modalExportCountInput.value = max;
            }
        });

        modalExportPathSelectButton.addEventListener('click', async () => {
            const result = await window.api.invoke('select-path', 'folder');
            if (result) {
                modalExportPathInput.value = result;
            }
        });
        modal.dataset.listenerAdded = true;
    }

    modal.classList.add('flex');
    modal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');

    document.getElementById('modal-export-close').addEventListener('click', closeExportModal);
    document.getElementById('modal-export-confirm').addEventListener('click', exportConfirm);
}

async function exportConfirm() {
    const start = await operationStartCheck('export');
    if (start) {
        const count = document.getElementById('modal-export-count').value;
        const exportPath = document.getElementById('modal-export-path').value;
        const scope = document.querySelector('input[name="export-scope"]:checked').value;

        let wikiIds = null;
        if (scope !== 'all') {
            // The restore table is the only one whose rows are guaranteed to have backups
            const table = document.querySelector(`#${scope}`);
            const selectedRows = table.querySelectorAll('.row-checkbox:checked');
            wikiIds = Array.from(selectedRows).map(checkbox => {
                return checkbox.closest('tr').getAttribute('data-wiki-id').trim();
            });
            if (wikiIds.length === 0) {
                showAlert('warning', await window.i18n.translate('alert.no_games_selected'));
                await closeExportModal();
                return;
            }
        }

        window.api.send("export-backups", count, exportPath, wikiIds);
    }
    await closeExportModal();
}

async function closeExportModal() {
    const modal = document.getElementById('modal-export');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalExportPathInput = document.getElementById('modal-export-path');

    const saved = await window.api.invoke('save-settings', 'exportPath', modalExportPathInput.value);
    if (!saved) {
        showAlert('warning', await window.i18n.translate('settings.save-settings-error'));
    }

    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalOverlay.classList.add('hidden');
}

// Import modal
export function showImportModal(gsmPath) {
    const modal = document.getElementById('modal-import');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalImportPathInput = document.getElementById('modal-import-path');
    const modalImportPathSelectButton = document.getElementById('modal-import-select-path');

    if (!modalOverlay.classList.contains('hidden')) return;

    if (gsmPath) modalImportPathInput.value = gsmPath;
    if (!modal.dataset.listenerAdded) {
        modalImportPathSelectButton.addEventListener('click', async () => {
            const result = await window.api.invoke('select-path', 'gsmr');
            if (result) {
                modalImportPathInput.value = result;
            }
        });
        modal.dataset.listenerAdded = true;
    }

    modal.classList.add('flex');
    modal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');

    document.getElementById('modal-import-close').addEventListener('click', closeImportModal);
    document.getElementById('modal-import-confirm').addEventListener('click', importConfirm);
}

async function importConfirm() {
    const start = await operationStartCheck('import');
    if (start) {
        const importPath = document.getElementById('modal-import-path').value;
        window.api.send("import-backups", importPath);
    }
    closeImportModal();
}

function closeImportModal() {
    const modal = document.getElementById('modal-import');
    const modalOverlay = document.getElementById('modal-overlay');

    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalOverlay.classList.add('hidden');
}

// ======================================================================
// Progress
