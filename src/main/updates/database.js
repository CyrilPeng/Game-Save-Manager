const fs = require('node:fs/promises');
const { createReadStream, createWriteStream, constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const sqlite3 = require('sqlite3');
const axios = require('axios');
const project = require('../../project');
const MAX_BYTES = 128 * 1024 * 1024;

async function validateDatabase(filename, expectedHash) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size < 100 || stat.size > MAX_BYTES)
    throw new Error('Invalid database size');
  if (expectedHash) {
    if (!/^[a-f0-9]{64}$/.test(expectedHash))
      throw new Error('Invalid database checksum');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    if (hash.digest('hex') !== expectedHash)
      throw new Error('Database checksum mismatch');
  }
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(
      filename,
      sqlite3.OPEN_READONLY,
      (error) => (error ? reject(error) : resolve(connection)),
    );
  });
  const query = (sql) =>
    new Promise((resolve, reject) =>
      db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))),
    );
  try {
    const check = await query('PRAGMA integrity_check');
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok')
      throw new Error('Database integrity check failed');
    const columns = new Set(
      (await query('PRAGMA table_info(games)')).map((column) => column.name),
    );
    if (
      ![
        'wiki_page_id',
        'title',
        'save_location',
        'platform',
        'install_folder',
        'steam_id',
        'gog_id',
        'zh_CN',
      ].every((column) => columns.has(column))
    )
      throw new Error('Unsupported game database schema');
  } finally {
    await new Promise((resolve, reject) =>
      db.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function installDatabase(source, destination, expectedHash) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const staging = destination + '.pending-' + randomUUID();
  try {
    await fs.copyFile(source, staging, constants.COPYFILE_EXCL);
    await validateDatabase(staging, expectedHash);
    await fs.rename(staging, destination);
  } finally {
    await fs.rm(staging, { force: true });
  }
}

async function updateDatabaseFromRelease({
  release,
  destination,
  request = axios.get,
  onProgress = () => {},
}) {
  const database = release?.assets?.find(
    (asset) => asset.name === 'database.db',
  );
  const manifest = release?.assets?.find(
    (asset) => asset.name === 'database-manifest.json',
  );
  for (const asset of [database, manifest]) {
    if (
      !asset?.browser_download_url?.startsWith(
        project.releasesUrl + '/download/',
      )
    )
      throw new Error('This release has no database update');
  }
  const { data: info } = await request(manifest.browser_download_url, {
    timeout: 15000,
    maxContentLength: 65536,
  });
  if (!/^[a-f0-9]{64}$/.test(info?.sha256))
    throw new Error('Invalid database manifest');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const download = destination + '.download-' + randomUUID();
  try {
    const response = await request(database.browser_download_url, {
      timeout: 30000,
      responseType: 'stream',
    });
    let received = 0;
    const measure = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_BYTES)
          return callback(new Error('Database download is too large'));
        try {
          onProgress(received, database.size);
          callback(null, chunk);
        } catch (error) {
          callback(error);
        }
      },
    });
    await pipeline(
      response.data,
      measure,
      createWriteStream(download, { flags: 'wx' }),
    );
    await installDatabase(download, destination, info.sha256);
  } finally {
    await fs.rm(download, { force: true });
  }
}
module.exports = {
  validateDatabase,
  installDatabase,
  updateDatabaseFromRelease,
};
