
const fsOriginal = require('original-fs');

const path = require('path');

const moment = require('moment');
const IO_CONCURRENCY = 16;

// Runs worker over items at most IO_CONCURRENCY at a time, keeping input order.
async function mapConcurrent(items, worker, limit = IO_CONCURRENCY) {
    const results = new Array(items.length);
    let next = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    });

    await Promise.all(runners);
    return results;
}

// The one recursive walk: sizing already stats every file, so the newest file time is free
const EMPTY_WALK = { size: 0, modifiedMs: 0 };

async function walkDirectory(directoryPath, ignoreConfig = true) {
    try {
        const stats = await fsOriginal.promises.stat(directoryPath);
        if (!stats.isDirectory()) {
            return { size: stats.size, modifiedMs: stats.mtimeMs };
        }

        const entries = await fsOriginal.promises.readdir(directoryPath, { withFileTypes: true });
        const walked = await Promise.all(entries.map(async (entry) => {
            if (ignoreConfig && entry.name === 'backup_info.json') {
                return EMPTY_WALK;
            }
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                return walkDirectory(entryPath);
            }
            const fileStats = await fsOriginal.promises.stat(entryPath);
            return { size: fileStats.size, modifiedMs: fileStats.mtimeMs };
        }));

        return walked.reduce((total, entry) => ({
            size: total.size + entry.size,
            modifiedMs: Math.max(total.modifiedMs, entry.modifiedMs),
        }), EMPTY_WALK);

    } catch (error) {
        // A missing path is a normal answer of zero, so callers need no existence check
        if (error.code !== 'ENOENT') {
            console.error(`Error walking ${directoryPath}:`, error);
        }
        return EMPTY_WALK;
    }
}

async function calculateDirectorySize(directoryPath, ignoreConfig = true) {
    return (await walkDirectory(directoryPath, ignoreConfig)).size;
}

// Backup-tree JSON, on original-fs; the trailing newline matches what fs-extra wrote
async function readJsonFile(filePath) {
    return JSON.parse(await fsOriginal.promises.readFile(filePath, 'utf8'));
}

async function writeJsonFile(filePath, data) {
    await fsOriginal.promises.writeFile(filePath, JSON.stringify(data, null, 4) + '\n');
}

// Rounded to the minute, so equal-minute folders tie instead of flapping
async function getLatestModificationTime(directoryPath) {
    const { modifiedMs } = await walkDirectory(directoryPath);
    return moment(modifiedMs).seconds(0).milliseconds(0).toDate();
}

// Async like the copy: it walks the whole save before one is taken
async function ensureWritable(pathToCheck) {
    let stats;
    try {
        stats = await fsOriginal.promises.stat(pathToCheck);
    } catch {
        return;
    }

    if (stats.isDirectory()) {
        const entries = await fsOriginal.promises.readdir(pathToCheck, { withFileTypes: true });
        for (const entry of entries) {
            await ensureWritable(path.join(pathToCheck, entry.name));
        }

    } else if (!(stats.mode & 0o200)) {
        try {
            await fsOriginal.promises.chmod(pathToCheck, 0o666);
        } catch (error) {
            console.error(`Error changing permissions for ${pathToCheck}: ${error.message}`);
        }
    }
}

// Async: a sync copy holds the event loop for its whole duration, freezing the window
async function fsOriginalCopyFolder(source, target) {
    await fsOriginal.promises.mkdir(target, { recursive: true });

    const entries = await fsOriginal.promises.readdir(source, { withFileTypes: true });

    for (const entry of entries) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(target, entry.name);

        if (entry.isDirectory()) {
            await fsOriginalCopyFolder(sourcePath, destinationPath);
        } else {
            await fsOriginal.promises.copyFile(sourcePath, destinationPath);
        }
    }
}

module.exports = { mapConcurrent, walkDirectory, calculateDirectorySize, readJsonFile, writeJsonFile, getLatestModificationTime, ensureWritable, fsOriginalCopyFolder };
