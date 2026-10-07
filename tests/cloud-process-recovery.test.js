// Real child termination, SQLite/WAL recovery, 7-Zip and disposable remote files.
// Run with node --test test/cloud-process-recovery.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { CloudStore } = require('../src/main/cloud/store');
const { CloudRepository } = require('../src/main/cloud/repository');
const archive = require('../src/main/archive');
const { createFileProvider } = require('./fixtures/cloud-process-recovery.cjs');

function startOwnedChild(root, checkpoint, mode) {
    const child = fork(path.join(__dirname, 'fixtures', 'cloud-process-recovery.cjs'), [root, checkpoint, mode], {
        windowsHide: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data.toString()).slice(-6000); });
    const closed = once(child, 'close');
    const message = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Fixture child timed out at ${checkpoint}/${mode}: ${output}`)); }, 25000);
        child.on('message', value => {
            if (value.type === 'failure') { clearTimeout(timer); reject(new Error(value.message)); }
            else if (value.type === (mode === 'start' ? 'checkpoint' : 'completed')) { clearTimeout(timer); resolve(value); }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Fixture child exited before its result (${code}/${signal}): ${output}`)); });
    });
    return { child, message, closed };
}

const expectedStages = {
    packaging: 'packaging', uploading: 'uploading', verifying: 'verifying', committing: 'committing',
    'manifest-written': 'committing', deleting: 'deleting', 'tombstone-written': 'deleting', 'manifest-deleted': 'deleting'
};

for (const [checkpoint, expectedStage] of Object.entries(expectedStages)) {
    test(`forced process termination at ${checkpoint} resumes its durable task without duplicate publication or resurrection`, { timeout: 60000 }, async t => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gsm-cloud-process-'));
        const children = [];
        t.after(async () => {
            for (const item of children) {
                if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
                await item.closed.catch(() => {});
            }
            await fsp.rm(root, { recursive: true, force: true });
        });
        const remote = path.join(root, 'remote');
        await fsp.mkdir(path.join(remote, 'unrelated'), { recursive: true });
        await fsp.writeFile(path.join(remote, 'unrelated', 'keep.txt'), 'not owned by a cloud backup task');
        const first = startOwnedChild(root, checkpoint, 'start'); children.push(first);
        const reached = await first.message;
        assert.equal(reached.checkpoint, checkpoint);
        assert.equal(reached.stage, expectedStage);
        // Only the process returned by this fork is killed. No signal handler,
        // CloudService.close(), app process search or taskkill is involved.
        assert.equal(first.child.kill('SIGKILL'), true);
        const [exitCode, signal] = await first.closed;
        assert.ok(exitCode !== 0 || signal === 'SIGKILL');

        const store = new CloudStore(path.join(root, 'user-data', 'GSM Cloud', 'cloud.db'));
        await store.open();
        const interrupted = await store.get('jobs', reached.jobId);
        const target = (await store.list('targets'))[0], device = await store.get('settings', 'device');
        await store.close();
        assert.equal(interrupted.stage, expectedStage, 'stage must already be durable before termination');
        assert.equal(interrupted.attempts, 1);
        const provider = await createFileProvider(remote);
        const repository = new CloudRepository(provider, target.config, device);
        const beforeKeys = await provider.allKeys();
        const tombstoned = ['tombstone-written', 'manifest-deleted'].includes(checkpoint);
        const visibleBefore = await repository.browse();
        assert.equal(visibleBefore.manifests.length, ['manifest-written', 'deleting'].includes(checkpoint) ? 1 : 0);
        assert.equal(beforeKeys.filter(key => key.endsWith('/deleted.json')).length, tombstoned ? 1 : 0);
        if (['verifying', 'committing'].includes(checkpoint)) {
            assert.ok(beforeKeys.includes(interrupted.manifest.archiveKey));
            assert.equal(beforeKeys.filter(key => key.endsWith('/manifest.json')).length, 0);
        }

        const recovered = startOwnedChild(root, checkpoint, 'resume'); children.push(recovered);
        const result = await recovered.message;
        const [recoveredExit] = await recovered.closed;
        assert.equal(recoveredExit, 0);
        const resumed = result.jobs.find(job => job.id === reached.jobId);
        assert.equal(resumed.stage, 'succeeded');
        assert.equal(resumed.recovered, true);
        assert.equal(resumed.attempts, 2);
        assert.equal(result.jobs.filter(job => job.kind === 'upload').length, 1);
        const keys = await provider.allKeys(), listing = await repository.browse();
        assert.equal(await fsp.readFile(path.join(remote, 'unrelated', 'keep.txt'), 'utf8'), 'not owned by a cloud backup task');
        if (reached.kind === 'upload') {
            assert.equal(result.versions, 1);
            assert.equal(listing.manifests.length, 1);
            assert.equal(keys.filter(key => key.endsWith('/manifest.json')).length, 1);
            assert.equal(keys.filter(key => key.endsWith('.gsmr')).length, 1);
            const manifest = listing.manifests[0];
            assert.equal(manifest.snapshotId, interrupted.snapshotId);
            await repository.verifyPayload(manifest);
            const extracted = path.join(root, 'verified-extraction');
            await archive.extractSnapshotArchive(path.join(remote, ...manifest.archiveKey.split('/')), extracted, manifest);
            const source = path.join(interrupted.sourcePath, 'path1', 'save.dat');
            const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
            assert.equal(digest(path.join(extracted, 'path1', 'save.dat')), digest(source));
        } else {
            assert.equal(result.versions, 0);
            assert.equal(listing.manifests.length, 0);
            assert.equal(keys.filter(key => key.endsWith('/deleted.json')).length, 1);
            assert.equal(keys.filter(key => key.endsWith('/manifest.json') || key.endsWith('.gsmr')).length, 0);
            await assert.rejects(repository.publish(interrupted.manifest, path.join(root, 'unused.gsmr')), { code: 'SNAPSHOT_DELETED' });
        }
    });
}
