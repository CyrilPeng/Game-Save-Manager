let status = {
    backuping: false,
    scanning_full: false,
    restoring: false,
    migrating: false,
    updating_db: false,
    exporting: false,
    importing: false,
    updating_backup: false,
    updating_restore: false
}

function updateStatus(key, value) { status[key] = value; }
module.exports = { getStatus: () => status, updateStatus };
