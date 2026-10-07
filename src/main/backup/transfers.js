const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');
const i18next = require('i18next');
const moment = require('moment');
const { getMainWin } = require('../app/windows');
const { getSettings } = require('../settings/store');
const { getStatus } = require('../app/state');
const snapshotStore = require('./snapshotStore');
const coordinator = require('./backupCoordinator');
const customGameStore = require('../games/customGameStore');
const archive = require('./archive');
async function exportBackups(count, exportPath, wikiIds = null) {
  const progressId = 'export';
  const progressTitle = i18next.t('alert.exporting');
  const sourcePath = getSettings().backupPath;
  const releases = [];

  try {
    if (!exportPath) {
      getMainWin().webContents.send(
        'show-alert',
        'warning',
        i18next.t('alert.empty_export_path'),
      );
      return;
    }

    if (!getStatus().exporting) {
      getStatus().exporting = true;
      getMainWin().webContents.send(
        'update-progress',
        progressId,
        progressTitle,
        'start',
      );

      // Build the list of relative paths to archive
      let itemsToArchive = [];

      const customEntriesPath = path.join(sourcePath, 'custom_entries.json');
      if (fsOriginal.existsSync(customEntriesPath)) {
        itemsToArchive.push('custom_entries.json');
      }

      const allSnapshots = await snapshotStore.listSnapshots(sourcePath);
      let gameFolders = [
        ...new Set(allSnapshots.map((snapshot) => snapshot.gameId)),
      ];

      // Filter to selected games if wikiIds provided
      if (wikiIds && wikiIds.length > 0) {
        const wikiIdSet = new Set(wikiIds.map(String));
        gameFolders = gameFolders.filter((folder) => wikiIdSet.has(folder));
      }

      // Newest backup instances per game, plus every permanent one regardless of count
      for (const gameId of gameFolders) {
        await coordinator.withGameLock(gameId, async () => {
          const backups = await snapshotStore.listSnapshots(sourcePath, gameId);
          const selected = [
            ...backups.filter((s) => s.metadata.is_permanent),
            ...backups.filter((s) => !s.metadata.is_permanent).slice(0, count),
          ];
          for (let snapshot of selected) {
            snapshot = await snapshotStore.ensureIdentity(snapshot);
            releases.push(coordinator.protectSnapshot(snapshot.path));
            itemsToArchive.push(`${gameId}/${snapshot.folder}`);
          }
        });
      }

      const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss-SSS');
      const finalFileName = `GSMBackup-${timestamp}.gsmr`;
      const finalDestPath = path.join(exportPath, finalFileName);

      if (!itemsToArchive.length)
        throw new Error('No complete snapshots to export');
      await archive.createArchive(sourcePath, itemsToArchive, finalDestPath);
      getMainWin().webContents.send(
        'update-progress',
        progressId,
        progressTitle,
        'end',
      );
      getMainWin().webContents.send(
        'show-alert',
        'success',
        i18next.t('alert.export_success'),
      );
      getStatus().exporting = false;
    }
  } catch (error) {
    console.error(
      `An error occurred while exporting backups: ${error.message}`,
    );
    getMainWin().webContents.send(
      'show-alert',
      'modal',
      i18next.t('alert.error_during_export'),
      error.message,
    );
    getMainWin().webContents.send(
      'update-progress',
      progressId,
      progressTitle,
      'end',
    );
    getStatus().exporting = false;
  } finally {
    releases.forEach((release) => release());
  }
}

async function importBackups(gsmPath) {
  const progressId = 'import';
  const progressTitle = i18next.t('alert.importing');
  const destinationPath = getSettings().backupPath;
  let tempExtractPath;

  try {
    if (!getStatus().importing) {
      getStatus().importing = true;
      getMainWin().webContents.send(
        'update-progress',
        progressId,
        progressTitle,
        'start',
      );

      // 1. Extract the GSMR file to a temporary directory
      tempExtractPath = fsOriginal.mkdtempSync(
        path.join(os.tmpdir(), 'GSMImportTemp-'),
      );
      await archive.extractArchive(gsmPath, tempExtractPath, {
        onProgress: (done, total) => {
          getMainWin().webContents.send(
            'update-progress',
            progressId,
            progressTitle,
            total ? Math.floor((done / total) * 50) : 0,
          );
        },
      });

      const extractedItems = fsOriginal.readdirSync(tempExtractPath);

      // 2. Process the custom_entries.json file if present
      if (extractedItems.includes('custom_entries.json')) {
        const importedJsonPath = path.join(
          tempExtractPath,
          'custom_entries.json',
        );
        if (fsOriginal.statSync(importedJsonPath).size > 4 * 1024 * 1024)
          throw new Error('Custom definitions exceed limit');
        const importedEntries = JSON.parse(
          fsOriginal.readFileSync(importedJsonPath, 'utf8'),
        );
        if (!Array.isArray(importedEntries))
          throw new Error('Invalid custom definitions');

        await customGameStore.updateCustomEntries(
          destinationPath,
          (destinationEntries) => {
            // Preserve existing local definitions when IDs are already known.
            for (const imported of importedEntries) {
              const id = snapshotStore.validateGameId(imported.wiki_page_id);
              if (
                !destinationEntries.some(
                  (entry) =>
                    entry.wiki_page_id.toLowerCase() === id.toLowerCase(),
                )
              )
                destinationEntries.push(imported);
            }
            return destinationEntries;
          },
        );
      }

      // 3. Process game backup folders
      let totalBackups = extractedItems.length;
      let processedBackups = 0;

      for (const item of extractedItems) {
        const itemPath = path.join(tempExtractPath, item);
        if (fsOriginal.lstatSync(itemPath).isDirectory()) {
          const gameId = item;
          snapshotStore.validateGameId(gameId);

          const backupFolders = fsOriginal
            .readdirSync(itemPath)
            .filter((sub) => {
              const subPath = path.join(itemPath, sub);
              return fsOriginal.lstatSync(subPath).isDirectory();
            });

          for (const backupFolder of backupFolders) {
            const snapshot = await snapshotStore.readSnapshot(
              tempExtractPath,
              gameId,
              backupFolder,
            );
            const result = await snapshotStore.importSnapshot(
              destinationPath,
              snapshot.path,
              { ...snapshot.metadata, gameId },
            );
            if (result.conflict)
              throw new Error(
                `Snapshot identity conflict; preserved in ${result.quarantinedPath}`,
              );
          }
        }

        processedBackups++;
        const movingProgress = totalBackups
          ? Math.floor((processedBackups / totalBackups) * 50)
          : 50;
        const overallProgress = 50 + movingProgress;
        getMainWin().webContents.send(
          'update-progress',
          progressId,
          progressTitle,
          overallProgress,
        );
      }

      getMainWin().webContents.send(
        'show-alert',
        'success',
        i18next.t('alert.import_success'),
      );
      getStatus().importing = false;
    }
  } catch (error) {
    console.error(
      `An error occurred while importing backups: ${error.message}`,
    );
    getMainWin().webContents.send(
      'show-alert',
      'modal',
      i18next.t('alert.error_during_import'),
      error.message,
    );
    getStatus().importing = false;
  } finally {
    if (tempExtractPath)
      await fsOriginal.promises
        .rm(tempExtractPath, { recursive: true, force: true })
        .catch(() => {});
    getMainWin().webContents.send(
      'update-progress',
      progressId,
      progressTitle,
      'end',
    );
    getMainWin().webContents.send('update-backup-table');
    getMainWin().webContents.send('update-restore-table');
  }
}

module.exports = { exportBackups, importBackups };
