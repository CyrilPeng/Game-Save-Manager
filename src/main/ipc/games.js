const { randomUUID } = require('crypto');

const os = require('os');

const i18next = require('i18next');

const { pinyin } = require('pinyin');

const { getMainWin, osKeyMap } = require('../global');
const { getAllAccountIds } = require('../games/gameData');

function registerGamesIpc(ipcMain) {
  // ======================================================================
  // Games and custom entries
  // ======================================================================

  // Sort objects using object.titleToSort
  ipcMain.handle('sort-games', (event, games) => {
    const gamesWithSortedTitles = games.map((game) => {
      try {
        const isChinese = /[\u4e00-\u9fff]/.test(game.titleToSort);
        const titleToSort = isChinese
          ? pinyin(game.titleToSort, { style: pinyin.STYLE_NORMAL }).join(' ')
          : game.titleToSort.toLowerCase();
        return { ...game, titleToSort };
      } catch (error) {
        console.error(`Error sorting game ${game.titleToSort}: ${error.stack}`);
        getMainWin().webContents.send(
          'show-alert',
          'modal',
          `${i18next.t('alert.sort_failed', { game_name: game.titleToSort })}`,
          error.message,
        );
        return { ...game, titleToSort: '' };
      }
    });

    return gamesWithSortedTitles.sort((a, b) => {
      return a.titleToSort.localeCompare(b.titleToSort);
    });
  });

  require('./customEntries').registerCustomEntriesIpc(ipcMain);

  ipcMain.handle('get-account-data', () => {
    return getAllAccountIds();
  });

  ipcMain.handle('get-platform', () => {
    return osKeyMap[os.platform()];
  });

  ipcMain.handle('get-uuid', () => {
    return randomUUID();
  });
}
module.exports = { registerGamesIpc };
