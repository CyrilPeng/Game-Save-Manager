const { app, dialog } = require('electron');

const { execFile } = require('child_process');
const fs = require('fs');
const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');
const util = require('util');

const fse = require('fs-extra');

const i18next = require('i18next');
const moment = require('moment');
const sqlite3 = require('sqlite3');

const {
  getMainWin,
  getStatus,
  updateStatus,
  getGameDisplayName,
  mapConcurrent,
  walkDirectory,
  readJsonFile,
  getNewestBackup,
  findGameInstallPath,
  osKeyMap,
  getSettings,
  saveSettings,
} = require('../global');

const { getRegistryExportSize } = require('../platform/registry');

const execFilePromise = util.promisify(execFile);

const { resolveTemplatedBackupPath } = require('./savePaths');
const databasePath = () =>
  path.join(app.getPath('userData'), 'GSM Database', 'database.db');

// Seeds the user's copy from the one shipped alongside the app on first run.
async function ensureDatabase() {
  if (fs.existsSync(databasePath())) return true;

  const installedDbPath = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'database', 'database.db')
    : path.join(app.getAppPath(), 'resources', 'database', 'database.db');

  if (!fs.existsSync(installedDbPath)) {
    dialog.showErrorBox(
      i18next.t('alert.missing_database_file'),
      i18next.t('alert.missing_database_file_message'),
    );
    return false;
  }

  const { installDatabase } = require('../updates/database');
  const manifest = require('../../../resources/database/database-manifest.json');
  await installDatabase(installedDbPath, databasePath(), manifest.sha256);
  return true;
}

// Promise wrapper for sqlite3's callback API, which every query here goes through.
function queryAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// One query per chunk rather than per value, kept under SQLite's 999 variable limit
const SQL_VARIABLE_LIMIT = 900;

async function queryGamesByColumn(db, column, values) {
  const rows = [];

  for (let start = 0; start < values.length; start += SQL_VARIABLE_LIMIT) {
    const chunk = values.slice(start, start + SQL_VARIABLE_LIMIT);
    const placeholders = chunk.map(() => '?').join(',');
    const chunkRows = await queryAll(
      db,
      `SELECT * FROM games WHERE ${column} IN (${placeholders})`,
      chunk.map(String),
    );
    rows.push(...chunkRows);
  }

  return rows;
}

async function updateDatabase() {
  if (getStatus().updating_db) return;
  updateStatus('updating_db', true);
  const notify = (channel, ...args) => {
    const win = getMainWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };
  const progressId = 'update-database';
  const progressTitle = i18next.t('alert.updating_database');
  notify('update-progress', progressId, progressTitle, 'start');
  try {
    const { createReleaseClient } = require('../updates/releases');
    const { updateDatabaseFromRelease } = require('../updates/database');
    const release = await createReleaseClient({
      currentVersion: app.getVersion(),
    }).latest();
    await updateDatabaseFromRelease({
      release,
      destination: databasePath(),
      onProgress: (received, total) =>
        notify(
          'update-progress',
          progressId,
          progressTitle,
          total ? Math.min(99, Math.round((received / total) * 100)) : 0,
        ),
    });
    notify('show-alert', 'success', i18next.t('alert.update_db_success'));
  } catch (error) {
    notify(
      'show-alert',
      'modal',
      i18next.t('alert.error_during_db_update'),
      error.message,
    );
  } finally {
    updateStatus('updating_db', false);
    notify('update-progress', progressId, progressTitle, 'end');
  }
}

// ======================================================================
// Game data
// ======================================================================
// Helper: parse common fields on a DB row
function parseDbRow(row) {
  row.wiki_page_id = row.wiki_page_id.toString();
  row.platform = JSON.parse(row.platform);
  row.save_location = JSON.parse(row.save_location);
  row.latest_backup = getNewestBackup(row.wiki_page_id);
}

// Helper: set install_path from the game install directories, returns true if found
function findInstallPath(row) {
  row.install_path = findGameInstallPath(row.install_folder);
  return Boolean(row.install_path);
}

// Helper: process game and push to array if it has valid resolved paths
async function processAndPushGame(row, games) {
  const processed = await process_game(row);
  if (processed.resolved_paths.length !== 0) {
    games.push(processed);
  }
}

// Games resolve in parallel; one that throws is reported and skipped
async function processRowsConcurrently(rows, games, errors, kind) {
  const resolved = await mapConcurrent(rows, async (row) => {
    try {
      parseDbRow(row);
      return await process_game(row);
    } catch (err) {
      console.error(
        `Error processing ${kind} game ${getGameDisplayName(row)}: ${err.stack}`,
      );
      errors.push(
        `${i18next.t('alert.backup_process_error_db', { game_name: getGameDisplayName(row) })}: ${err.message}`,
      );
      return null;
    }
  });

  games.push(
    ...resolved.filter((game) => game && game.resolved_paths.length !== 0),
  );
}

async function getGameDataFromDB(ignoreUninstalled = false, wikiId = null) {
  const games = [];
  const errors = [];
  const dbPath = databasePath();

  if (!(await ensureDatabase())) return { games, errors };

  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

  // If specific wikiId is provided, fetch only that game
  if (wikiId) {
    try {
      // 1. Check database
      const rows = await queryAll(
        db,
        'SELECT * FROM games WHERE wiki_page_id = ?',
        [wikiId],
      );

      if (rows && rows.length > 0) {
        const row = rows[0];
        parseDbRow(row);
        const isInstalled = findInstallPath(row);

        if (!isInstalled) {
          if (ignoreUninstalled || !getSettings().saveUninstalledGames) {
            return { games, errors };
          }
          const uninstalledWikiIds = (getSettings().uninstalledGames || []).map(
            String,
          );
          if (!uninstalledWikiIds.includes(row.wiki_page_id)) {
            return { games, errors };
          }
        }

        await processAndPushGame(row, games);
      } else {
        // 2. Fallback to checking custom games
        const customJsonPath = path.join(
          getSettings().backupPath,
          'custom_entries.json',
        );
        if (fsOriginal.existsSync(customJsonPath)) {
          const { customGames, customGameErrors } = await processCustomEntries(
            customJsonPath,
            wikiId,
          );
          games.push(...customGames);
          errors.push(...customGameErrors);
        }
      }
    } catch (error) {
      console.error(
        `Error fetching single game data for ${wikiId}: ${error.stack}`,
      );
      errors.push(
        `${i18next.t('alert.backup_process_error_db', { game_name: wikiId })}: ${error.message}`,
      );
    } finally {
      db.close();
    }
    return { games, errors };
  }

  return new Promise(async (resolve, reject) => {
    try {
      // 1. Process installed games by folder name
      const gameInstallPaths = getSettings().gameInstalls;

      // First install root wins, matching the old per-folder de-duplication
      const installPathByFolder = new Map();
      for (const installPath of gameInstallPaths) {
        for (const dirent of fsOriginal.readdirSync(installPath, {
          withFileTypes: true,
        })) {
          if (dirent.isDirectory() && !installPathByFolder.has(dirent.name)) {
            installPathByFolder.set(
              dirent.name,
              path.join(installPath, dirent.name),
            );
          }
        }
      }

      const installedRows = await queryGamesByColumn(db, 'install_folder', [
        ...installPathByFolder.keys(),
      ]);
      for (const row of installedRows) {
        row.install_path = installPathByFolder.get(row.install_folder);
      }
      await processRowsConcurrently(installedRows, games, errors, 'installed');

      // 2. Process uninstalled games by wiki id
      if (!ignoreUninstalled && getSettings().saveUninstalledGames) {
        const uninstalledWikiIds = getSettings().uninstalledGames || [];
        const processedWikiIds = new Set(
          games.map((game) => game.wiki_page_id),
        );
        const remainingUninstalledWikiIds = uninstalledWikiIds.filter(
          (id) => !processedWikiIds.has(id),
        );
        if (
          JSON.stringify([...remainingUninstalledWikiIds].sort()) !==
          JSON.stringify([...uninstalledWikiIds].sort())
        ) {
          await saveSettings('uninstalledGames', remainingUninstalledWikiIds);
        }

        const uninstalledRows = await queryGamesByColumn(
          db,
          'wiki_page_id',
          remainingUninstalledWikiIds,
        );
        await processRowsConcurrently(
          uninstalledRows,
          games,
          errors,
          'uninstalled',
        );
      }

      // 3. Process custom entries
      const customJsonPath = path.join(
        getSettings().backupPath,
        'custom_entries.json',
      );

      if (fsOriginal.existsSync(customJsonPath)) {
        const { customGames, customGameErrors } =
          await processCustomEntries(customJsonPath);
        games.push(...customGames);
        errors.push(...customGameErrors);
      }
    } catch (error) {
      console.error(`Error displaying backup table: ${error.stack}`);
      errors.push(
        `${i18next.t('alert.backup_process_error_display')}: ${error.message}`,
      );
    } finally {
      db.close();
      resolve({ games, errors });
    }
  });
}

async function getAllGameDataFromDB() {
  const games = [];
  const errors = [];
  const dbPath = databasePath();

  if (!getStatus().scanning_full) {
    if (!(await ensureDatabase())) return { games, errors };

    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const progressId = 'scan-full';
    const progressTitle = i18next.t('alert.scanning_full');
    const mainWin = getMainWin();

    mainWin.webContents.send(
      'update-progress',
      progressId,
      progressTitle,
      'start',
    );
    updateStatus('scanning_full', true);

    try {
      const rows = await queryAll(db, 'SELECT * FROM games');

      const totalRows = rows.length;
      let processedRows = 0;
      let reportedProgress = -1;

      const scanned = await mapConcurrent(rows, async (row) => {
        let processed = null;
        try {
          parseDbRow(row);
          processed = await process_game(row);
        } catch (err) {
          console.error(
            `Error processing database game ${getGameDisplayName(row)}: ${err.stack}`,
          );
          errors.push(
            `${i18next.t('alert.backup_process_error_db', { game_name: getGameDisplayName(row) })}: ${err.message}`,
          );
        }

        processedRows++;
        // Only on change, or concurrent rows resend the same percent
        const dbProgress = Math.floor((processedRows / totalRows) * 95);
        if (dbProgress !== reportedProgress) {
          reportedProgress = dbProgress;
          mainWin.webContents.send(
            'update-progress',
            progressId,
            progressTitle,
            dbProgress,
          );
        }
        return processed;
      });

      games.push(
        ...scanned.filter((game) => game && game.resolved_paths.length !== 0),
      );

      const customJsonPath = path.join(
        getSettings().backupPath,
        'custom_entries.json',
      );
      if (fsOriginal.existsSync(customJsonPath)) {
        const { customGames, customGameErrors } =
          await processCustomEntries(customJsonPath);
        games.push(...customGames);
        errors.push(...customGameErrors);
      }

      mainWin.webContents.send(
        'update-progress',
        progressId,
        progressTitle,
        100,
      );
      mainWin.webContents.send(
        'show-alert',
        'success',
        i18next.t('alert.scan_full_complete'),
      );
    } catch (error) {
      console.error(`Error displaying backup table: ${error.stack}`);
      errors.push(
        `${i18next.t('alert.backup_process_error_display')}: ${error.message}`,
      );
    } finally {
      updateStatus('scanning_full', false);
      mainWin.webContents.send(
        'update-progress',
        progressId,
        progressTitle,
        'end',
      );
      db.close();
      return { games, errors };
    }
  }
}

// Names only, for the hidden-games modal, which has no use for save paths
async function getGameTitlesByIds(wikiIds) {
  const results = [];
  if (!wikiIds || wikiIds.length === 0) {
    return results;
  }

  const dbPath = databasePath();
  if (!fs.existsSync(dbPath)) {
    return results;
  }

  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  try {
    const placeholders = wikiIds.map(() => '?').join(',');
    const rows = await queryAll(
      db,
      `SELECT wiki_page_id, title, zh_CN FROM games WHERE wiki_page_id IN (${placeholders})`,
      wikiIds.map(String),
    );

    for (const row of rows) {
      results.push({
        wiki_page_id: row.wiki_page_id.toString(),
        title: row.title,
        zh_CN: row.zh_CN,
      });
    }
  } catch (error) {
    console.error(`Error fetching game titles by ids: ${error.message}`);
  } finally {
    db.close();
  }

  return results;
}

async function processCustomEntries(customJsonPath, targetWikiId = null) {
  const customGames = [];
  const customGameErrors = [];

  const customEntries = await readJsonFile(customJsonPath);
  const entriesToProcess = targetWikiId
    ? customEntries.filter((e) => e.wiki_page_id === targetWikiId)
    : customEntries;

  const processed = await mapConcurrent(
    entriesToProcess,
    async (customEntry) => {
      try {
        findInstallPath(customEntry);
        customEntry.platform = ['Custom'];
        customEntry.latest_backup = getNewestBackup(customEntry.wiki_page_id);
        for (const plat in customEntry.save_location) {
          customEntry.save_location[plat] = customEntry.save_location[plat].map(
            (entry) => entry.template,
          );
        }

        return await process_game(customEntry);
      } catch (err) {
        console.error(
          `Error processing custom game ${customEntry.title}: ${err.stack}`,
        );
        customGameErrors.push(
          `${i18next.t('alert.backup_process_error_custom', { game_name: customEntry.title })}: ${err.message}`,
        );
        return null;
      }
    },
  );

  customGames.push(
    ...processed.filter((game) => game && game.resolved_paths.length !== 0),
  );

  return { customGames, customGameErrors };
}

async function process_game(db_game_row) {
  const resolved_paths = [];
  let totalBackupSize = 0;
  let latestModifiedMs = 0;

  const currentOS = os.platform();
  const osKey = osKeyMap[currentOS];

  if (osKey && db_game_row.save_location[osKey]) {
    for (const templatedPath of db_game_row.save_location[osKey]) {
      const resolvedPathObjs = await resolveTemplatedBackupPath(
        templatedPath,
        db_game_row.install_path,
        false,
      );

      // Walked all at once; a missing path sizes to zero, which excludes it below
      const walked = await Promise.all(
        resolvedPathObjs.map((resolvedPathObj) =>
          walkDirectory(resolvedPathObj.resolved),
        ),
      );

      resolvedPathObjs.forEach((resolvedPathObj, index) => {
        if (walked[index].size > 0) {
          totalBackupSize += walked[index].size;
          latestModifiedMs = Math.max(
            latestModifiedMs,
            walked[index].modifiedMs,
          );
          resolved_paths.push(resolvedPathObj);
        }
      });
    }
  }

  // Process registry paths
  if (
    osKey === 'win' &&
    db_game_row.save_location['reg'] &&
    db_game_row.save_location['reg'].length > 0
  ) {
    for (const templatedPath of db_game_row.save_location['reg']) {
      const resolvedPathObjs = await resolveTemplatedBackupPath(
        templatedPath,
        null,
        true,
      );

      // Sizing a key also answers whether it exists, so it doubles as the check
      for (const resolvedPathObj of resolvedPathObjs) {
        const normalizedRegPath = path.normalize(resolvedPathObj.resolved);
        const exportSize = getRegistryExportSize(normalizedRegPath);
        if (exportSize !== null) {
          totalBackupSize += exportSize;
          resolved_paths.push({
            template: resolvedPathObj.template,
            finalTemplate: resolvedPathObj.finalTemplate,
            resolved: normalizedRegPath,
            type: 'reg',
          });
        }
      }
    }
  }

  db_game_row.resolved_paths = resolved_paths;
  db_game_row.backup_size = totalBackupSize;
  // A registry-only save has no file to date, so there is no time to show
  db_game_row.latest_modified = latestModifiedMs
    ? moment(latestModifiedMs).format('YYYY/MM/DD HH:mm')
    : '-';

  return db_game_row;
}

// ======================================================================
// Path resolution
// ======================================================================

module.exports = {
  getGameDataFromDB,
  getAllGameDataFromDB,
  getGameTitlesByIds,
  updateDatabase,
};
