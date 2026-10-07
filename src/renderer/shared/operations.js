import { showAlert } from './alerts.js';
export async function operationStartCheck(operation) {
  const status = await window.api.invoke('get-status');

  // Each operation lists the status flags that must be false before it can start
  const statusChecks = {
    backup: {
      restoring: 'alert.wait_for_restore',
      scanning_full: 'alert.wait_for_scan_full',
      migrating: 'alert.wait_for_migrate',
      updating_db: 'alert.wait_for_updating_db',
      exporting: 'alert.wait_for_export',
      importing: 'alert.wait_for_import',
      updating_backup: 'alert.wait_for_updating_backup',
      updating_restore: 'alert.wait_for_updating_restore',
    },
    'scan-full': {
      backuping: 'alert.wait_for_backup',
      restoring: 'alert.wait_for_restore',
      migrating: 'alert.wait_for_migrate',
      updating_db: 'alert.wait_for_updating_db',
      exporting: 'alert.wait_for_export',
      importing: 'alert.wait_for_import',
      updating_backup: 'alert.wait_for_updating_backup',
    },
    restore: {
      restoring: 'alert.wait_for_restore',
      backuping: 'alert.wait_for_backup',
      migrating: 'alert.wait_for_migrate',
      importing: 'alert.wait_for_import',
      updating_backup: 'alert.wait_for_updating_backup',
      updating_restore: 'alert.wait_for_updating_restore',
    },
    'change-settings': {
      backuping: 'alert.wait_for_backup',
      restoring: 'alert.wait_for_restore',
      scanning_full: 'alert.wait_for_scan_full',
      migrating: 'alert.wait_for_migrate',
      updating_db: 'alert.wait_for_updating_db',
      exporting: 'alert.wait_for_export',
      importing: 'alert.wait_for_import',
      updating_backup: 'alert.wait_for_updating_backup',
      updating_restore: 'alert.wait_for_updating_restore',
    },
    'save-custom': {
      backuping: 'alert.wait_for_backup',
      restoring: 'alert.wait_for_restore',
      scanning_full: 'alert.wait_for_scan_full',
      migrating: 'alert.wait_for_migrate',
      exporting: 'alert.wait_for_export',
      importing: 'alert.wait_for_import',
      updating_backup: 'alert.wait_for_updating_backup',
    },
    'update-db': {
      updating_db: 'alert.wait_for_updating_db',
      backuping: 'alert.wait_for_backup',
      scanning_full: 'alert.wait_for_scan_full',
      importing: 'alert.wait_for_import',
      updating_backup: 'alert.wait_for_updating_backup',
    },
    export: {
      exporting: 'alert.wait_for_export',
      backuping: 'alert.wait_for_backup',
      scanning_full: 'alert.wait_for_scan_full',
      migrating: 'alert.wait_for_migrate',
      importing: 'alert.wait_for_import',
      updating_backup: 'alert.wait_for_updating_backup',
      updating_restore: 'alert.wait_for_updating_restore',
    },
    import: {
      importing: 'alert.wait_for_import',
      backuping: 'alert.wait_for_backup',
      restoring: 'alert.wait_for_restore',
      scanning_full: 'alert.wait_for_scan_full',
      migrating: 'alert.wait_for_migrate',
      exporting: 'alert.wait_for_export',
      updating_backup: 'alert.wait_for_updating_backup',
      updating_restore: 'alert.wait_for_updating_restore',
    },
  };

  const alerts = statusChecks[operation];
  for (const [key, message] of Object.entries(alerts)) {
    if (status[key]) {
      showAlert('warning', await window.i18n.translate(message));
      return false;
    }
  }

  return true;
}
