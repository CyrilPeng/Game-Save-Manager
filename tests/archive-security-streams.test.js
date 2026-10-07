const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Readable } = require('node:stream');
const { setImmediate: nextTurn } = require('node:timers/promises');
const archive = require('../src/main/backup/archive');
const snapshots = require('../src/main/backup/snapshotStore');
const { createS3 } = require('../src/main/cloud/providers/s3');
const { createWebDAV } = require('../src/main/cloud/providers/webdav');
const { progressStream } = require('../src/main/cloud/providers/common');
const { request } = require('../src/main/cloud/providers/transport');

const s3Config = { bucket: 'bucket', prefix: 'prefix', proxy: { mode: 'direct' } };
const secrets = { accessKeyId: 'key', secretAccessKey: 'secret' };
async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-security-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
async function serve(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}

function tarEntry(name, content, type = '0', link = '') {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write('00000000000\0', 136, 12); header.fill(32, 148, 156);
    header.write(type, 156, 1); header.write(link, 157, 100); header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]);
}

test('real traversal and symlink archives are rejected before creating extraction output', async t => {
    const root = await temporary(t);
    for (const [name, archiveBytes] of [
        ['traversal', tarEntry('../outside.dat', Buffer.from('must not escape'))],
        ['symlink', tarEntry('link', Buffer.alloc(0), '2', '../outside.dat')],
    ]) {
        const input = path.join(root, `${name}.gsmr`);
        const destination = path.join(root, name);
        await fs.writeFile(input, archiveBytes);
        await assert.rejects(archive.extractArchive(input, destination), /Unsafe|links/);
        await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    }
    await assert.rejects(fs.stat(path.join(root, 'outside.dat')), { code: 'ENOENT' });
});

test('S3 creation failure destroys an unconsumed upload source', async () => {
    const body = new Readable({ read() {} });
    const provider = createS3(s3Config, secrets, { multipartThreshold: 1, client: {
        async send() { throw new Error('creation failed'); }, destroy() {},
    } });
    await assert.rejects(provider.put('gsm/object', { body, size: 100 }), /creation failed/);
    await nextTurn();
    assert.equal(body.destroyed, true);
    provider.close();
});

test('S3 cancellation aborts only the recorded multipart ID using a fresh cleanup signal', async () => {
    const controller = new AbortController();
    const body = new Readable({ read() {} });
    const calls = [], records = [];
    const provider = createS3(s3Config, secrets, { multipartThreshold: 1, client: {
        async send(command, options) {
            calls.push({ name: command.constructor.name, input: command.input, signal: options.abortSignal });
            return command.constructor.name === 'CreateMultipartUploadCommand' ? { UploadId: 'owned-upload' } : {};
        }, destroy() {},
    } });
    await assert.rejects(provider.put('gsm/object', {
        body, size: 100, signal: controller.signal,
        onMultipart: value => { records.push(value); if (value) controller.abort(); },
    }), error => error.name === 'AbortError');
    const cleanup = calls.find(call => call.name === 'AbortMultipartUploadCommand');
    assert.equal(cleanup.input.UploadId, 'owned-upload');
    assert.equal(cleanup.input.Key, 'prefix/gsm/object');
    assert.equal(cleanup.signal.aborted, false);
    assert.equal(records.at(-1), null);
    await nextTurn(); assert.equal(body.destroyed, true);
    provider.close();
});

test('S3 restart cleanup treats an already completed or removed multipart ID as cleaned', async () => {
    const commands = [];
    const controller = new AbortController();
    const provider = createS3(s3Config, secrets, { client: {
        async send(command, options) { commands.push({ command, options }); throw Object.assign(new Error('gone'), { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } }); },
        destroy() {},
    } });
    await provider.abortMultipart('gsm/object', 'persisted-owned-id', { signal: controller.signal });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command.constructor.name, 'AbortMultipartUploadCommand');
    assert.equal(commands[0].options.abortSignal, controller.signal);
    provider.close();
});

test('S3 download stream remains cancellable after response headers arrive', async () => {
    const body = new Readable({ read() {} });
    const controller = new AbortController();
    const provider = createS3(s3Config, secrets, { client: { async send() { return { Body: body }; }, destroy() {} } });
    const response = await provider.get('gsm/object', { signal: controller.signal });
    const pending = (async () => { for await (const _chunk of response) {} })();
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(body.destroyed, true);
    provider.close();
});

test('progress wrapper rejects size changes and callback errors through the stream', async () => {
    const source = Readable.from([Buffer.from('payload')]);
    const counted = progressStream(source, () => { throw new Error('callback failed'); });
    await assert.rejects(async () => { for await (const _chunk of counted) {} }, /callback failed/);
    assert.equal(source.destroyed, true);
    const short = progressStream(Readable.from([Buffer.from('short')]), null, { expectedSize: 8 });
    await assert.rejects(async () => { for await (const _chunk of short) {} }, /size changed/);
});

test('WebDAV rejection closes the response and destroys a still-open upload', { timeout: 5000 }, async t => {
    let closed;
    const socketClosed = new Promise(resolve => { closed = resolve; });
    const url = await serve(t, (req, res) => {
        if (req.method === 'MKCOL') return res.end();
        req.resume();
        req.socket.once('close', closed);
        res.writeHead(401); res.write('authentication failure');
    });
    const provider = await createWebDAV({ url, prefix: '', proxy: { mode: 'direct' } });
    t.after(() => provider.close());
    let pushed = false;
    const body = new Readable({ read() { if (!pushed) { pushed = true; this.push(Buffer.alloc(65536)); } } });
    await assert.rejects(provider.put('gsm/object', { body, size: 1000000 }), error => error.status === 401);
    await socketClosed;
    assert.equal(body.destroyed, true);
});

test('WebDAV checks entity-encoded and CDATA multistatus failures and rejects XML declarations', async t => {
    let mode = 'entity';
    const url = await serve(t, (_req, res) => {
        res.writeHead(207);
        const status = mode === 'entity' ? 'HTTP/1.1&#32;403 Forbidden' : '<![CDATA[HTTP/1.1 403 Forbidden]]>';
        res.end(`${mode === 'doctype' ? '<!DOCTYPE a [<!ENTITY x "bad">]>' : ''}<d:multistatus xmlns:d="DAV:"><d:response><d:status>${status}</d:status></d:response></d:multistatus>`);
    });
    for (const current of ['entity', 'cdata', 'doctype']) {
        mode = current;
        const response = await request({ url, method: 'PROPFIND' });
        await assert.rejects(response.text(), error => current === 'doctype' ? /declarations/.test(error.message) : error.status === 403);
    }
});

test('Jianguoyun directory cap fails refresh rather than presenting a truncated complete list', async () => {
    const provider = await createWebDAV({ url: 'https://dav.jianguoyun.com/dav', prefix: '', proxy: { mode: 'direct' } }, {}, {
        client: { async getDirectoryContents() { return Array.from({ length: 750 }, (_, i) => ({ filename: `/gsm/${i}`, type: 'file', size: 1 })); } },
    });
    await assert.rejects(provider.list('gsm/'), { code: 'LISTING_LIMIT' });
    provider.close();
});

test('cancelled archive extraction removes all partial outputs', async t => {
    const root = await temporary(t);
    const source = path.join(root, 'source'); await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'a.bin'), Buffer.alloc(256 * 1024, 5));
    const file = path.join(root, 'test.gsmr');
    await archive.createArchive(source, ['a.bin'], file);
    const controller = new AbortController();
    const destination = path.join(root, 'partial');
    await assert.rejects(archive.extractArchive(file, destination, {
        signal: controller.signal, onProgress: () => controller.abort(),
    }), error => error.name === 'AbortError' || /cancel|abort/i.test(error.message));
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('cancelled archive preparation interrupts copy and removes its private staging tree', async t => {
    const root = await temporary(t);
    const source = path.join(root, 'source'); await fs.mkdir(path.join(source, 'path1'), { recursive: true });
    await fs.writeFile(path.join(source, 'path1', 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 7));
    const controller = new AbortController();
    const output = path.join(root, 'output.gsmr');
    const pending = archive.createSnapshotArchive({ path: source, metadata: { backup_paths: [{ folder_name: 'path1', type: 'folder', template: 'template' }] } }, output, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.package-')), false);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    await assert.rejects(snapshots.computeContentHash(source, { backup_paths: [] }, { signal: controller.signal }), error => error.name === 'AbortError');
});
