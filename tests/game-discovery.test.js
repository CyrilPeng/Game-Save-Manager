const test = require('node:test');
const assert = require('node:assert/strict');
const { createMainLoader } = require('./helpers/load-main.cjs');
test('account discovery tolerates a machine with no launchers installed', async () => {
  const load = createMainLoader({
    fs: { existsSync: () => false },
    glob: { glob: async () => [], sync: () => [] },
    './registry': { getRegistryValue: () => null },
    './global': {
      getLatestModificationTime: async () => 0,
      placeholder_mapping: {},
    },
  });
  const games = load('gameData');
  await games.initializeGameData();
  assert.equal(games.getGameData().ubisoftPath, null);
  assert.equal(games.resolvePlaceholder('{{p|steam}}'), null);
  assert.equal(games.resolvePlaceholder('{{p|uplay}}'), null);
});
