const fsp = require('node:fs/promises');
const path = require('node:path');
const { cloudError } = require('./queue');
function frozenMetadata(metadata) {
  const pick = (source, fields) =>
    Object.fromEntries(
      fields
        .filter(
          (key) =>
            source[key] === null ||
            ['string', 'number', 'boolean'].includes(typeof source[key]),
        )
        .map((key) => [key, source[key]]),
    );
  const result = pick(metadata, [
    'schemaVersion',
    'minimumReaderVersion',
    'snapshotId',
    'sourceSnapshotId',
    'originDeviceId',
    'deviceId',
    'createdAt',
    'gameKey',
    'title',
    'zh_CN',
    'backup_size',
    'customName',
    'custom_name',
    'isPermanent',
    'is_permanent',
    'legacyDate',
    'timezoneUncertain',
    'platform',
  ]);
  result.backup_paths = metadata.backup_paths.map((entry) =>
    pick(entry, [
      'folder_name',
      'template',
      'originalTemplate',
      'type',
      'install_folder',
      'file_name',
    ]),
  );
  if (Array.isArray(metadata.platform))
    result.platform = metadata.platform
      .filter((value) => typeof value === 'string')
      .slice(0, 100);
  if (metadata.accountScope)
    result.accountScope = pick(metadata.accountScope, [
      'steamId64',
      'steamAccountId',
      'ubisoftAccountId',
      'epicAccountId',
      'xboxAccountId',
      'rockstarAccountId',
    ]);
  if (metadata.customDefinition) {
    result.customDefinition = pick(metadata.customDefinition, [
      'title',
      'wiki_page_id',
      'install_folder',
    ]);
    result.customDefinition.save_location = {};
    for (const platform of ['win', 'mac', 'linux', 'reg'])
      if (Array.isArray(metadata.customDefinition.save_location?.[platform]))
        result.customDefinition.save_location[platform] =
          metadata.customDefinition.save_location[platform].map((entry) =>
            pick(entry, ['template', 'type']),
          );
  }
  return result;
}

async function directorySize(directory) {
  let bytes = 0;
  let count = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) throw cloudError('INVALID_REQUEST');
    if (++count > 1000000) throw cloudError('SPACE_LIMIT');
    if (stat.isDirectory()) {
      for (const name of await fsp.readdir(current))
        pending.push(path.join(current, name));
    } else if (stat.isFile()) bytes += stat.size;
    else throw cloudError('INVALID_REQUEST');
    if (!Number.isSafeInteger(bytes)) throw cloudError('SPACE_LIMIT');
  }
  return bytes;
}

module.exports = { frozenMetadata, directorySize };
