/** Shared IPC contract. Payload validation remains in the main process. */
const LEGACY_CHANNELS = {
  send: Object.freeze(['load-theme', 'update-app', 'update-status', 'show-row-menu', 'hide-row-menu', 'row-menu-measured',
    'row-menu-action', 'open-backup-folder', 'browse-local-save', 'migrate-backups', 'export-backups', 'import-backups', 'update-backup-table']),
  receive: Object.freeze(['apply-theme', 'apply-language', 'show-alert', 'open-export-modal', 'open-import-modal', 'update-progress',
    'view_account_ids', 'app-update-ended', 'update-backup-table', 'update-restore-table', 'scan-full', 'open-hidden-games-modal',
    'auto-backup-started', 'auto-backup-stopped', 'auto-backup-performed', 'row-menu-action', 'render-row-menu']),
  invoke: Object.freeze(['get-current-version', 'get-latest-version', 'translate', 'open-url', 'get-settings', 'start-scan-full',
    'fetch-backup-table-data', 'fetch-restore-table-data', 'save-settings', 'get-icon-map', 'get-auto-backup-state', 'backup-game',
    'update-database', 'get-uuid', 'get-platform', 'select-path', 'save-custom-entries', 'load-custom-entries', 'sort-games',
    'stop-auto-backup', 'start-auto-backup', 'confirm-delete-local-save', 'update-backup-info', 'confirm-delete-backup',
    'get-game-titles', 'restore-game', 'open-backup-dialog', 'get-detected-game-paths', 'open-dialog', 'get-account-data', 'get-status'])
};
const CLOUD_COMMANDS = Object.freeze({
    getState: [], saveTarget: ['config', 'secrets', 'sessionOnly'], removeTarget: ['targetId'],
    testConnection: ['targetId', 'config', 'secrets'], discoverRepositories: ['targetId'],
    createRepository: ['targetId'], selectRepository: ['targetId', 'repositoryId'],
    setAutomatic: ['targetId', 'gameKeys'], setCacheBudget: ['bytes'], setDevice: ['name'],
    listLocalSnapshots: ['gameId'], previewUpload: ['targetId', 'selection', 'gameIds'],
    upload: ['targetId', 'gameId', 'folder'], uploadMany: ['targetId', 'selection', 'gameIds'],
    refresh: ['targetId'], download: ['targetId', 'versionId', 'revision'], restore: ['targetId', 'versionId', 'revision'],
    deleteVersion: ['targetId', 'versionId', 'revision', 'confirmPermanent'], controlJob: ['jobId', 'action'],
    chooseRestoreMapping: ['jobId', 'folder'], confirmRestore: ['jobId', 'confirmRegistry']
});
const CLOUD_METHODS = Object.freeze(Object.keys(CLOUD_COMMANDS));
module.exports = { LEGACY_CHANNELS: Object.freeze(LEGACY_CHANNELS), CLOUD_COMMANDS, CLOUD_METHODS };
