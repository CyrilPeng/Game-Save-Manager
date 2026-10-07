import { changeTheme } from './i18n.js';
import { showAlert } from './alerts.js';
import { showExportModal, showImportModal } from './transfers.js';
import { updateProgress } from './progress.js';
import { showAccountModal } from './accounts.js';
window.api.send('load-theme');

window.api.receive('apply-theme', (theme) => {
  changeTheme(theme);
});

window.api.receive('show-alert', (type, message, modalContent) => {
  showAlert(type, message, modalContent);
});

window.api.receive('open-export-modal', () => {
  showExportModal();
});

window.api.receive('open-import-modal', (gsmPath) => {
  showImportModal(gsmPath);
});

window.api.receive(
  'update-progress',
  (progressId, progressTitle, percentage) => {
    updateProgress(progressId, progressTitle, percentage);
  },
);

window.api.receive('view_account_ids', () => {
  showAccountModal();
});
