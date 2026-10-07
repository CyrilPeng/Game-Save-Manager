const { getMainWin } = require('../app/windows');
const { getSettings, saveSettings } = require('../settings/store');
const { getStatus } = require('../app/state');
const coordinator = require('./backupCoordinator');
const i18next = require('i18next');

function createMigrationController({
  getMainWin,
  getSettings,
  saveSettings,
  getStatus,
  coordinator,
  i18next,
}) {
  return async function moveFilesWithProgress(sourceDir, destinationDir) {
    const win = getMainWin();
    const settings = getSettings();
    const status = getStatus();
    const { migrateBackupLibrary } = require('./backupMigration');
    const progressId = 'migrate-backups';
    const progressTitle = i18next.t('alert.migrate_backups');
    const notify = (channel, ...args) => {
      try {
        if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
      } catch {
        /* Closing a window cannot invalidate the verified migration. */
      }
    };
    status.migrating = true;
    notify('update-progress', progressId, progressTitle, 'start');
    try {
      const result = await migrateBackupLibrary(sourceDir, destinationDir, {
        onProgress: ({ stage, completedBytes, totalBytes }) => {
          const fraction = totalBytes ? completedBytes / totalBytes : 1;
          const progress =
            stage === 'copying'
              ? fraction * 45
              : stage === 'verifying'
                ? 45 + fraction * 50
                : 98;
          notify(
            'update-progress',
            progressId,
            progressTitle,
            Math.round(progress),
          );
        },
        activate: async (destination) => {
          const previousPath = settings.backupPath;
          try {
            const saved = await saveSettings('backupPath', destination);
            if (saved !== null) return true;
          } catch (error) {
            settings.backupPath = previousPath;
            throw error;
          }
          // saveSettings changes in-memory settings before disk I/O.
          settings.backupPath = previousPath;
          return false;
        },
      });
      notify(
        'show-alert',
        'success',
        i18next.t('alert.backup_migration_success'),
      );
      notify(
        'show-alert',
        'warning',
        i18next.t('alert.backup_migration_source_retained', {
          defaultValue:
            '新备份库已验证并启用。原备份库保留在 {{source}}，确认新位置可用后可手动清理。',
          source: result.source,
        }),
      );
      notify('update-restore-table');
      notify('update-backup-table');
      return { success: true, ...result };
    } catch (error) {
      const details = [error.message];
      if (error.destinationCommitted)
        details.push(
          i18next.t('alert.backup_migration_setting_failed', {
            defaultValue:
              '原备份库仍完整保留；目标目录也保留了已验证副本，但未确认配置切换成功。',
          }),
        );
      notify(
        'show-alert',
        'modal',
        i18next.t('alert.error_during_backup_migration'),
        details,
      );
      return {
        success: false,
        error: error.message,
        code: error.code,
        sourceRetained: true,
        destinationCommitted: !!error.destinationCommitted,
      };
    } finally {
      notify('update-progress', progressId, progressTitle, 'end');
      status.migrating = coordinator.isLibraryBusy();
    }
  };
}
module.exports = {
  createMigrationController,
  moveFilesWithProgress: createMigrationController({
    getMainWin,
    getSettings,
    saveSettings,
    getStatus,
    coordinator,
    i18next,
  }),
};
