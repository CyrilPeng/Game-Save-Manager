const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { CloudRepository } = require('../src/main/cloud/repository');
const { snapshotPrefix } = require('../src/main/cloud/format');

function fixture() {
    const repositoryId = randomUUID();
    const objects = new Map();
    const reads = [];
    const failures = new Map();
    const provider = {
        list: async prefix => ({ items: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }),
        stat: async key => objects.has(key) ? { size: objects.get(key).length } : null,
        get: async key => {
            reads.push(key);
            if (failures.has(key)) throw failures.get(key);
            if (!objects.has(key)) throw Object.assign(new Error('Missing'), { code: 'NOT_FOUND' });
            return Readable.from(objects.get(key));
        },
    };
    const repository = new CloudRepository(provider, { repositoryId }, { id: randomUUID(), name: 'Local device' });
    const deviceKey = id => `${repository.root()}/devices/${id}/device.json`;
    const addSnapshot = (deviceId = randomUUID()) => {
        const snapshotId = randomUUID();
        const prefix = snapshotPrefix(repositoryId, deviceId, 'pcgw:42', snapshotId);
        const manifest = {
            schemaVersion: 1, minimumReaderVersion: 1, repositoryId, publisherDeviceId: deviceId,
            originDeviceId: deviceId, snapshotId, gameKey: 'pcgw:42', title: 'Game',
            createdAt: '2026-10-05T01:02:03.000Z', uploadedAt: '2026-10-05T01:02:04.000Z',
            archiveSha256: 'a'.repeat(64), contentHash: 'b'.repeat(64), archiveSize: 1, unpackedSize: 1, fileCount: 1,
            archiveKey: `${prefix}/payload-${'a'.repeat(64)}.gsmr`,
            backup_paths: [{ folder_name: 'path1', type: 'file', template: 'save.dat' }],
        };
        objects.set(`${prefix}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
        objects.set(manifest.archiveKey, Buffer.from('x'));
        return manifest;
    };
    return { repository, objects, reads, failures, deviceKey, addSnapshot };
}

test('cloud discovery reads one validated label per publisher without changing immutable manifests', async () => {
    const x = fixture();
    const first = x.addSnapshot();
    const second = x.addSnapshot(first.publisherDeviceId);
    const label = '  游戏电脑 <img src=x>  ';
    const key = x.deviceKey(first.publisherDeviceId);
    x.objects.set(key, Buffer.from(JSON.stringify({ schemaVersion: 1, deviceId: first.publisherDeviceId, name: label })));
    const result = await x.repository.browse();
    assert.deepEqual(result.manifests, [first, second]);
    assert.deepEqual(result.deviceNames, { [first.publisherDeviceId]: label.trim() });
    assert.equal(result.invalidCount, 0);
    assert.equal(x.reads.filter(read => read === key).length, 1);
});

test('missing, corrupt or mismatched optional labels never remove valid cloud versions', async t => {
    const badLabels = {
        missing: undefined,
        malformed: '{',
        array: '[]',
        wrongIdentity: { schemaVersion: 1, deviceId: randomUUID(), name: 'Wrong device' },
        futureFormat: { schemaVersion: 2, name: 'Future device' },
        empty: { schemaVersion: 1, name: '   ' },
        long: { schemaVersion: 1, name: 'a'.repeat(101) },
        control: { schemaVersion: 1, name: 'Device\nSpoofed label' },
        number: { schemaVersion: 1, name: 42 },
    };
    for (const [name, data] of Object.entries(badLabels)) await t.test(name, async () => {
        const x = fixture();
        const manifest = x.addSnapshot();
        if (data !== undefined) x.objects.set(x.deviceKey(manifest.publisherDeviceId), Buffer.from(typeof data === 'string' ? data :
            JSON.stringify({ deviceId: manifest.publisherDeviceId, ...data })));
        const result = await x.repository.browse();
        assert.deepEqual(result.manifests, [manifest]);
        assert.deepEqual(result.deviceNames, {});
        assert.equal(result.invalidCount, 0);
    });
});

test('one failed device lookup leaves the other publisher labels and all versions visible', async () => {
    const x = fixture();
    const first = x.addSnapshot();
    const second = x.addSnapshot();
    x.failures.set(x.deviceKey(first.publisherDeviceId), Object.assign(new Error('Network unavailable'), { code: 'NETWORK_ERROR' }));
    x.objects.set(x.deviceKey(second.publisherDeviceId), Buffer.from(JSON.stringify({ schemaVersion: 1, deviceId: second.publisherDeviceId, name: 'Steam Deck' })));
    const result = await x.repository.browse();
    assert.deepEqual(result.manifests, [first, second]);
    assert.deepEqual(result.deviceNames, { [second.publisherDeviceId]: 'Steam Deck' });
});

test('cancellation during optional device lookup still stops cloud discovery', async () => {
    const x = fixture();
    const manifest = x.addSnapshot();
    const controller = new AbortController();
    const get = x.repository.provider.get;
    const cancelled = Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
    x.repository.provider.get = async key => {
        if (key === x.deviceKey(manifest.publisherDeviceId)) { controller.abort(); throw cancelled; }
        return get(key);
    };
    await assert.rejects(x.repository.browse(controller.signal), error => error === cancelled);
});
