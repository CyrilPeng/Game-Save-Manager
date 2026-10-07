const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mainRoot = path.resolve(__dirname, '../../src/main');
/** Load the actual module graph with only platform and filesystem boundaries replaced. */
function createMainLoader(overrides) {
  const cache = new Map();
  const locations = {
    archive: 'backup/archive.js',
    autoBackup: 'backup/autoBackup.js',
    backup: 'backup/backup.js',
    backupCoordinator: 'backup/backupCoordinator.js',
    backupMigration: 'backup/backupMigration.js',
    restore: 'backup/restore.js',
    snapshotStore: 'backup/snapshotStore.js',
    customGameStore: 'games/customGameStore.js',
    gameData: 'games/gameData.js',
    registry: 'platform/registry.js',
    settingsValidation: 'settings/validation.js',
    hotReload: 'app/hotReload.js',
    menuWindow: 'app/menuWindow.js',
  };
  function load(name) {
    name = locations[name] || name;
    const filename = path.resolve(
      mainRoot,
      name.endsWith('.js') ? name : name + '.js',
    );
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = createRequire(filename);
    const requireWithOverrides = (key) => {
      const overrideKey = key.startsWith('.') ? './' + path.basename(key) : key;
      if (Object.hasOwn(overrides, key)) return overrides[key];
      if (Object.hasOwn(overrides, overrideKey)) return overrides[overrideKey];
      if (key.startsWith('.')) {
        const resolved = localRequire.resolve(key);
        if (
          resolved.startsWith(mainRoot + path.sep) &&
          resolved.endsWith('.js')
        )
          return load(path.relative(mainRoot, resolved));
      }
      return localRequire(key);
    };
    const wrapper = vm.runInThisContext(
      '(function(require,module,exports,__filename,__dirname){' +
        fs.readFileSync(filename, 'utf8') +
        '\n})',
      { filename },
    );
    wrapper(
      requireWithOverrides,
      module,
      module.exports,
      filename,
      path.dirname(filename),
    );
    return module.exports;
  }
  return load;
}
module.exports = { createMainLoader };
