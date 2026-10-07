const { dialog } = require('electron');

const fs = require('fs');

const path = require('path');

const i18next = require('i18next');

const { getMainWin } = require('../global');

const {
  getGameDataFromDB,
  getGameTitlesByIds,
  backupGame,
} = require('../backup/backup');
const {
  getGameDataForRestore,
  restoreGame,
  restoreSnapshot,
} = require('../backup/restore');

const { chooseRestoreDestination } = require('./restoreDestination');

function registerTablesIpc(ipcMain) {
  // ======================================================================
  // Table data
  // ======================================================================

  ipcMain.handle('get-icon-map', async () => {
    return {
      Custom: fs.readFileSync(
        path.join(__dirname, '../assets/custom.svg'),
        'utf-8',
      ),
      Steam: fs.readFileSync(
        path.join(__dirname, '../assets/steam.svg'),
        'utf-8',
      ),
      Ubisoft: fs.readFileSync(
        path.join(__dirname, '../assets/ubisoft.svg'),
        'utf-8',
      ),
      EA: fs.readFileSync(path.join(__dirname, '../assets/ea.svg'), 'utf-8'),
      Epic: fs.readFileSync(
        path.join(__dirname, '../assets/epic.svg'),
        'utf-8',
      ),
      GOG: fs.readFileSync(path.join(__dirname, '../assets/gog.svg'), 'utf-8'),
      Xbox: fs.readFileSync(
        path.join(__dirname, '../assets/xbox.svg'),
        'utf-8',
      ),
      Blizzard: fs.readFileSync(
        path.join(__dirname, '../assets/battlenet.svg'),
        'utf-8',
      ),
    };
  });

  ipcMain.handle(
    'fetch-backup-table-data',
    async (event, ignoreUninstalled, wikiId = null) => {
      const { games, errors } = await getGameDataFromDB(
        ignoreUninstalled,
        wikiId,
      );

      if (errors.length > 0) {
        getMainWin().webContents.send(
          'show-alert',
          'modal',
          i18next.t('alert.backup_process_error_display'),
          errors,
        );
      }

      return games;
    },
  );

  ipcMain.on('update-backup-table', async (event) => {
    getMainWin().webContents.send('update-backup-table');
  });

  ipcMain.handle('backup-game', async (event, gameObj) => {
    return await backupGame(gameObj);
  });

  ipcMain.handle(
    'fetch-restore-table-data',
    async (event, wikiId = null, sizeAllBackups = false) => {
      const { games, errors } = await getGameDataForRestore(
        wikiId,
        sizeAllBackups,
      );

      if (errors.length > 0) {
        getMainWin().webContents.send(
          'show-alert',
          'modal',
          i18next.t('alert.restore_process_error_display'),
          errors,
        );
      }

      return games;
    },
  );

  ipcMain.handle('restore-game', async (event, gameObj, userActionForAll) => {
    let result = await restoreGame(gameObj, userActionForAll);
    const mappings = {};
    let confirmRegistry = false;
    // Legacy imports also use the same explicit local mapping and protected restore.
    for (
      let attempt = 0;
      attempt < 3 &&
      ['PATH_MAPPING_REQUIRED', 'REGISTRY_CONFIRMATION_REQUIRED'].includes(
        result.code,
      );
      attempt++
    ) {
      for (const entry of result.mappingsRequired || []) {
        const destination = await chooseRestoreDestination(entry);
        if (!destination) return { ...result, code: 'SKIPPED' };
        mappings[entry.folder] = destination;
      }
      if (result.registryTargets) {
        const response = await dialog.showMessageBox(getMainWin(), {
          type: 'warning',
          title: i18next.t('alert.save_conflict'),
          message: result.registryTargets
            .map(
              (entry) =>
                `${entry.key}${entry.originalMissing ? ` — ${i18next.t('cloud.restore_missing_target')}` : ''}`,
            )
            .join('\n'),
          buttons: [i18next.t('alert.yes'), i18next.t('alert.no')],
          defaultId: 1,
          cancelId: 1,
        });
        if (response.response !== 0) return { ...result, code: 'SKIPPED' };
        confirmRegistry = true;
      }
      result = await restoreSnapshot({
        gameId: String(gameObj.wiki_page_id),
        folder: gameObj.folder || gameObj.backups?.[0]?.date,
        mappings,
        confirmRegistry,
        userActionForAll,
      });
    }
    return result;
  });

  ipcMain.handle('get-game-titles', async (event, wikiIds) => {
    return await getGameTitlesByIds(wikiIds);
  });
}
module.exports = { registerTablesIpc };
