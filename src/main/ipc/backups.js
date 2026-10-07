const { dialog, shell } = require('electron');

const fsOriginal = require('original-fs');

const path = require('path');

const i18next = require('i18next');

const moment = require('moment');

const {
  getMainWin,
  getStatus,
  updateStatus,
  browseLocalSave,
  deleteLocalSave,
  getSettings,
  moveFilesWithProgress,
} = require('../global');

const snapshotStore = require('../backup/snapshotStore');
const backupCoordinator = require('../backup/backupCoordinator');

function registerBackupsIpc(ipcMain, { getCloudService }) {
  // ======================================================================
  // Backup management
  // ======================================================================

  ipcMain.handle('confirm-delete-backup', async (event, wikiId, backupDate) => {
    try {
      const snapshot = await snapshotStore.readSnapshot(
        getSettings().backupPath,
        wikiId,
        backupDate,
      );
      const formattedDate = moment(snapshot.createdAt).format(
        'YYYY/MM/DD HH:mm',
      );

      const confirmTitle = i18next.t('alert.confirm_delete_backup_title');
      const baseMessage = i18next.t('alert.confirm_delete_backup_message');
      const confirmMessage = baseMessage.replace(
        '{{backup_date}}',
        formattedDate,
      );

      const response = await dialog.showMessageBox(getMainWin(), {
        type: 'warning',
        title: confirmTitle,
        message: confirmMessage,
        buttons: [i18next.t('alert.yes'), i18next.t('alert.no')],
        defaultId: 1,
        cancelId: 1,
      });

      // If user clicked "Yes"
      if (response.response === 0) {
        if (
          backupCoordinator.isProtected(snapshot.path) &&
          getCloudService()?.sourceUploadJobs(snapshot.path).length
        ) {
          const choice = await dialog.showMessageBox(getMainWin(), {
            type: 'warning',
            title: i18next.t('alert.confirm_delete_backup_title'),
            message: i18next.t('cloud.cancel_upload_before_delete'),
            buttons: [
              i18next.t('cloud.cancel_upload_and_delete'),
              i18next.t('cloud.keep_local_version'),
            ],
            defaultId: 1,
            cancelId: 1,
          });
          if (choice.response !== 0) return false;
          await getCloudService().cancelSourceUploads(snapshot.path);
        }
        return await backupCoordinator.withGameLock(wikiId, async () => {
          const current = await snapshotStore.readSnapshot(
            getSettings().backupPath,
            wikiId,
            backupDate,
          );
          if (
            backupCoordinator.isProtected(current.path) ||
            (current.metadata.cloudUploadIntent &&
              current.metadata.cloudUploadIntent.state !== 'completed')
          ) {
            throw new Error(
              'This snapshot is still needed by an upload or export. Complete or cancel that task before deleting it.',
            );
          }
          await fsOriginal.promises.rm(current.path, {
            recursive: true,
            force: true,
          });
          return true;
        });
      }

      return false;
    } catch (error) {
      console.error(
        `Error deleting backup ${backupDate} for id ${wikiId}:`,
        error.message,
      );
      getMainWin().webContents.send(
        'show-alert',
        'error',
        i18next.t('alert.backup_delete_failed'),
      );
      return false;
    }
  });

  ipcMain.handle(
    'update-backup-info',
    async (event, wikiId, backupDate, key, value) => {
      try {
        if (
          !['custom_name', 'is_permanent'].includes(key) ||
          (key === 'is_permanent'
            ? typeof value !== 'boolean'
            : typeof value !== 'string' || value.length > 1000)
        )
          throw new Error('Invalid backup metadata update');
        await backupCoordinator.withGameLock(wikiId, async () => {
          let snapshot = await snapshotStore.readSnapshot(
            getSettings().backupPath,
            wikiId,
            backupDate,
          );
          snapshot = await snapshotStore.ensureIdentity(snapshot);
          await snapshotStore.updateMetadata(snapshot, (metadata) => ({
            ...metadata,
            [key]: value,
          }));
        });
        return true;
      } catch (error) {
        console.error(
          `Error updating backup info for backup ${backupDate} for id ${wikiId}:`,
          error.message,
        );
        getMainWin().webContents.send(
          'show-alert',
          'error',
          i18next.t('alert.backup_update_failed'),
        );
        return false;
      }
    },
  );

  ipcMain.on('open-backup-folder', async (event, wikiId) => {
    const backupPath = path.join(getSettings().backupPath, wikiId.toString());
    if (
      fsOriginal.existsSync(backupPath) &&
      fsOriginal.readdirSync(backupPath).length > 0
    ) {
      await shell.openPath(backupPath);
    } else {
      getMainWin().webContents.send(
        'show-alert',
        'warning',
        i18next.t('alert.no_backups_found'),
      );
    }
  });

  ipcMain.on('browse-local-save', async (event, resolvedPaths) => {
    browseLocalSave(resolvedPaths);
  });

  ipcMain.handle('confirm-delete-local-save', async (event, resolvedPaths) => {
    return await deleteLocalSave(resolvedPaths);
  });

  ipcMain.on('migrate-backups', async (event, newBackupPath) => {
    const status = getStatus();
    const hasCloudJobs = getCloudService()?.hasUnfinishedJobs();
    if (
      hasCloudJobs ||
      status.importing ||
      status.exporting ||
      status.backuping ||
      status.restoring ||
      status.migrating ||
      backupCoordinator.isLibraryBusy?.()
    ) {
      getMainWin().webContents.send(
        'show-alert',
        'warning',
        i18next.t('cloud.migration_busy'),
      );
      return;
    }
    const currentBackupPath = getSettings().backupPath;
    await moveFilesWithProgress(currentBackupPath, newBackupPath);
  });

  ipcMain.handle('get-status', () => {
    return getStatus();
  });

  ipcMain.on('update-status', (event, statusKey, statusValue) => {
    console.log(`Updating status: ${statusKey} = ${statusValue}`);
    updateStatus(statusKey, statusValue);
  });
}
module.exports = { registerBackupsIpc };
