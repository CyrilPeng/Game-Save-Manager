// Disposable, disk-backed provider for forced-process-termination tests only.
// No network transport, real credentials or existing application storage is used.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

async function createFileProvider(root, checkpoint = async () => {}) {
    root = path.resolve(root);
    await fsp.mkdir(root, { recursive: true });
    function filename(key) {
        if (typeof key !== 'string' || !key || key.includes('\\') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe fixture key');
        const result = path.resolve(root, ...key.split('/'));
        if (!result.startsWith(root + path.sep)) throw new Error('Fixture key escaped its temporary directory');
        return result;
    }
    async function allKeys(directory = root, prefix = '') {
        const result = [];
        for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
            const key = `${prefix}${entry.name}`;
            if (entry.isDirectory()) result.push(...await allKeys(path.join(directory, entry.name), key + '/'));
            else if (entry.isFile() && !entry.name.endsWith('.partial')) result.push(key);
            else if (entry.isSymbolicLink()) throw new Error('Links are not allowed in the fixture');
        }
        return result.sort();
    }
    return {
        capabilities: { conditionalCreate: true }, allKeys,
        async ensureContainer() {}, close() {},
        async stat(key) {
            try { const stat = await fsp.stat(filename(key)); return stat.isFile() ? { size: stat.size } : null; }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        async list(prefix, { cursor } = {}) {
            const keys = (await allKeys()).filter(key => key.startsWith(prefix));
            const offset = Number(cursor || 0);
            const page = keys.slice(offset, offset + 2);
            return { items: await Promise.all(page.map(async key => ({ key, size: (await fsp.stat(filename(key))).size }))), cursor: offset + page.length < keys.length ? String(offset + page.length) : null };
        },
        async get(key) {
            const file = filename(key);
            try { await fsp.access(file); }
            catch (error) { if (error.code === 'ENOENT') error.status = 404; throw error; }
            return fs.createReadStream(file);
        },
        async put(key, { body, ifAbsent, signal }) {
            const file = filename(key), temporary = `${file}.${randomUUID()}.partial`;
            await fsp.mkdir(path.dirname(file), { recursive: true });
            if (ifAbsent && await this.stat(key)) throw Object.assign(new Error('Fixture object already exists'), { status: 412 });
            try {
                await pipeline(body, fs.createWriteStream(temporary, { flags: 'wx' }), { signal });
                const handle = await fsp.open(temporary, 'r+');
                try { await handle.sync(); } finally { await handle.close(); }
                await fsp.rename(temporary, file);
            } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
            if (key.endsWith('/manifest.json')) await checkpoint('manifest-written');
            else if (key.endsWith('/deleted.json')) await checkpoint('tombstone-written');
        },
        async delete(key) {
            await fsp.rm(filename(key), { force: true });
            if (key.endsWith('/manifest.json')) await checkpoint('manifest-deleted');
        }
    };
}

async function until(predicate, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Fixture task exceeded its deadline');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function send(message) {
    if (!process.send) throw new Error('This fixture must run as an owned child process');
    await new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

async function run() {
    const [directory, selectedCheckpoint, mode] = process.argv.slice(2);
    const checkpoints = ['packaging', 'uploading', 'verifying', 'committing', 'manifest-written', 'deleting', 'tombstone-written', 'manifest-deleted'];
    const root = path.resolve(directory || '');
    const temporaryRoot = path.resolve(os.tmpdir());
    if (!root.startsWith(temporaryRoot + path.sep) || !path.basename(root).startsWith('gsm-cloud-process-') || !checkpoints.includes(selectedCheckpoint) || !['start', 'resume'].includes(mode)) throw new Error('Invalid disposable fixture arguments');
    const { CloudService } = require('../../src/main/cloud/service');
    const { CloudStore } = require('../../src/main/cloud/store');
    const snapshots = require('../../src/main/backup/snapshotStore');
    const backupRoot = path.join(root, 'backups'), userDataPath = path.join(root, 'user-data');
    const kind = ['deleting', 'tombstone-written', 'manifest-deleted'].includes(selectedCheckpoint) ? 'delete' : 'upload';
    const store = new CloudStore(path.join(userDataPath, 'GSM Cloud', 'cloud.db'));
    let stopped = false;
    async function checkpoint(point) {
        if (mode !== 'start' || point !== selectedCheckpoint || stopped) return;
        stopped = true;
        // The store decorator runs after COMMIT and the provider after file sync
        // and rename/delete. The parent kills this exact fork while suspended.
        const job = (await store.list('jobs')).find(value => value.kind === kind && !['succeeded', 'cancelled'].includes(value.stage));
        if (!job) throw new Error('No durable task at requested checkpoint');
        await send({ type: 'checkpoint', checkpoint: point, jobId: job.id, stage: job.stage, kind });
        const keepAlive = setInterval(() => {}, 1000);
        await new Promise(() => {});
        clearInterval(keepAlive);
    }
    const put = store.put.bind(store);
    store.put = async (...args) => {
        await put(...args);
        if (args[0] === 'jobs') await checkpoint(args[2].stage);
    };
    const provider = await createFileProvider(path.join(root, 'remote'), checkpoint);
    await fsp.mkdir(backupRoot, { recursive: true });
    const service = new CloudService({ userDataPath, getBackupPath: () => backupRoot, store,
        createProvider: async () => provider, safeStorage: { isEncryptionAvailable: () => false } });
    try {
        await service.initialize();
        if (mode === 'start') {
            const snapshotId = randomUUID(), folder = `2026-10-05T00-00-00-000Z_${snapshotId}`;
            const snapshotPath = path.join(backupRoot, '42', folder);
            await fsp.mkdir(path.join(snapshotPath, 'path1'), { recursive: true });
            await fsp.writeFile(path.join(snapshotPath, 'path1', 'save.dat'), randomBytes(256 * 1024));
            await snapshots.atomicWriteJson(path.join(snapshotPath, 'backup_info.json'), {
                schemaVersion: 1, minimumReaderVersion: 1, snapshotId, gameKey: 'pcgw:42', title: 'Process recovery fixture', createdAt: '2026-10-05T00:00:00.000Z',
                backup_paths: [{ folder_name: 'path1', type: 'folder', template: '{{p|appdata}}/ProcessRecoveryFixture' }]
            });
            const saved = await service.saveTarget({ config: { type: 'webdav', name: 'Temporary file provider', url: 'https://fixture.invalid' } });
            const target = await service.createRepository({ targetId: saved.id });
            const uploaded = await service.upload({ targetId: target.id, gameId: '42', folder });
            await until(() => ['succeeded', 'failed'].includes(service.queue.jobs.get(uploaded.id).stage));
            if (service.queue.jobs.get(uploaded.id).stage !== 'succeeded') throw new Error('Fixture upload failed: ' + service.queue.jobs.get(uploaded.id).error?.code);
            if (kind === 'delete') {
                const job = await service.deleteVersion({ targetId: target.id, versionId: service.queue.jobs.get(uploaded.id).result.versionId });
                await until(() => ['succeeded', 'failed'].includes(service.queue.jobs.get(job.id).stage));
            }
            throw new Error('Requested termination checkpoint was not reached');
        }
        await until(() => [...service.queue.jobs.values()].every(job => ['succeeded', 'failed'].includes(job.stage)));
        const jobs = [...service.queue.jobs.values()];
        const failed = jobs.find(job => job.stage !== 'succeeded');
        if (failed) throw new Error('Recovered fixture task failed: ' + failed.error?.code);
        await until(() => !service.hasUnfinishedJobs());
        const target = (await store.list('targets'))[0];
        const listing = await service.refresh({ targetId: target.id });
        const result = { type: 'completed', jobs: jobs.map(job => ({ id: job.id, kind: job.kind, stage: job.stage, recovered: job.recovered === true, attempts: job.attempts })), versions: listing.versions.length };
        await service.close();
        await send(result);
        process.disconnect();
    } catch (error) { await service.close().catch(() => {}); throw error; }
}

if (require.main === module) run().catch(async error => {
    await send({ type: 'failure', message: error.message }).catch(() => {});
    process.exit(1);
});

module.exports = { createFileProvider };
