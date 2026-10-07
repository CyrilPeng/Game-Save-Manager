const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { request } = require('../src/main/cloud/providers/transport');
const { probe } = require('../src/main/cloud/providers/common');
const { createWebDAV } = require('../src/main/cloud/providers/webdav');
const { classifyError } = require('../src/main/cloud/queue');

// Public test-only certificate/key for local TLS fixtures. No system trust is
// changed: each test's HTTPS agent trusts only this fixture certificate.
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/webdav-localhost.crt'));
const key = fs.readFileSync(path.join(__dirname, 'fixtures/webdav-localhost.key'));
async function serve(t, handler, tls = false) {
    const server = tls ? https.createServer({ cert, key }, handler) : http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}
function agent(t) { const value = new https.Agent({ ca: cert }); t.after(() => value.destroy()); return value; }

test('download redirects stream bytes and permanently strip credentials when changing origin', async t => {
    const requests = [], payload = Buffer.alloc(256 * 1024, 7);
    let original;
    const cdn = await serve(t, (req, res) => {
        requests.push({ origin: 'cdn', headers: req.headers, url: req.url });
        if (req.url === '/signed?token=fixture') { res.writeHead(307, { location: `${original}/returned` }); res.end(); }
        else res.end(payload);
    }, true);
    original = await serve(t, (req, res) => {
        requests.push({ origin: 'original', headers: req.headers, url: req.url });
        if (req.url === '/start') { res.writeHead(302, { location: '/relative' }); res.end(); }
        else if (req.url === '/relative') { res.writeHead(302, { location: `${cdn}/signed?token=fixture` }); res.end(); }
        else res.end(payload);
    }, true);
    const response = await request({ url: `${original}/start`, method: 'GET', httpsAgent: agent(t), headers: {
        Authorization: 'Basic private-credential', Cookie: 'private-cookie', 'Proxy-Authorization': 'private-proxy',
        'X-Api-Key': 'private-api-key', Referer: 'private-referrer', Accept: 'application/octet-stream'
    } });
    const chunks = []; for await (const chunk of response.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.equal(requests.length, 4);
    assert.equal(requests[0].headers.authorization, 'Basic private-credential');
    assert.equal(requests[1].headers.authorization, 'Basic private-credential');
    for (const item of requests.slice(2)) {
        for (const header of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'referer']) assert.equal(item.headers[header], undefined);
        assert.equal(item.headers.accept, 'application/octet-stream');
    }
});

test('WebDAV connection probe follows a signed TLS download redirect and verifies its checksum', async t => {
    const objects = new Map();
    const cdn = await serve(t, (req, res) => {
        assert.equal(req.headers.authorization, undefined);
        res.end(objects.get(new URL(req.url, 'https://fixture').searchParams.get('key')));
    }, true);
    const url = await serve(t, async (req, res) => {
        if (req.method === 'PROPFIND') { res.writeHead(404); res.end(); }
        else if (req.method === 'MKCOL') { res.writeHead(201); res.end(); }
        else if (req.method === 'PUT') {
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            objects.set(req.url, Buffer.concat(chunks)); res.writeHead(201); res.end();
        } else if (req.method === 'DELETE') { objects.delete(req.url); res.writeHead(204); res.end(); }
        else { res.writeHead(302, { location: `${cdn}/download?key=${encodeURIComponent(req.url)}&signature=fixture` }); res.end(); }
    });
    const provider = await createWebDAV({ url, prefix: '', proxy: { mode: 'direct' } }, { username: 'fixture', password: 'private' }, {
        // Keep the real WebDAV SDK, authenticated transport and probe; supply
        // a local test CA to the SDK's client without weakening production TLS.
        client: require('webdav').createClient(url, { username: 'fixture', password: 'private', httpsAgent: agent(t) })
    });
    t.after(() => provider.close());
    const result = await provider.probe();
    for (const check of ['authentication', 'list', 'write', 'readback', 'delete']) assert.equal(result[check], true, JSON.stringify(result));
    assert.equal(result.error, undefined); assert.equal(objects.size, 0);
});

test('write methods, redirect loops, long chains and credential-bearing redirects are refused', async t => {
    let mode = 'loop', hits = 0;
    const url = await serve(t, (req, res) => {
        hits++;
        const location = mode === 'loop' ? '/start' : mode === 'credentials' ? 'https://user:password@localhost/private' : `/hop-${hits}`;
        res.writeHead(302, { location }); res.end();
    });
    for (const method of ['PUT', 'DELETE', 'PROPFIND', 'MKCOL']) await assert.rejects(request({ url: `${url}/start`, method }), { code: 'REDIRECT_REFUSED' });
    await assert.rejects(request({ url: `${url}/start`, method: 'GET' }), { code: 'REDIRECT_REFUSED' });
    mode = 'credentials'; await assert.rejects(request({ url: `${url}/start`, method: 'GET' }), { code: 'REDIRECT_REFUSED' });
    mode = 'chain'; hits = 0;
    await assert.rejects(request({ url: `${url}/start`, method: 'GET' }), { code: 'REDIRECT_REFUSED' });
    assert.equal(hits, 6);
    assert.equal(classifyError({ code: 'REDIRECT_REFUSED', status: 302 }).code, 'REDIRECT_REFUSED');
});

test('TLS downloads reject downgrade and cancellation remains effective after a redirect', async t => {
    let insecureHits = 0, headersReceived;
    const received = new Promise(resolve => { headersReceived = resolve; });
    const insecure = await serve(t, (_req, res) => { insecureHits++; res.end('unsafe'); });
    const destination = await serve(t, (_req, res) => { res.write('first'); headersReceived(); }, true);
    let mode = 'downgrade';
    const url = await serve(t, (_req, res) => { res.writeHead(302, { location: mode === 'downgrade' ? insecure : destination }); res.end(); }, true);
    const httpsAgent = agent(t);
    await assert.rejects(request({ url, method: 'GET', httpsAgent }), { code: 'REDIRECT_REFUSED' });
    assert.equal(insecureHits, 0);
    mode = 'cancel';
    const controller = new AbortController();
    const response = await request({ url, method: 'GET', httpsAgent, signal: controller.signal });
    const consuming = (async () => { for await (const _chunk of response.body) {} })();
    await received; controller.abort();
    await assert.rejects(consuming);
    assert.equal(response.body.destroyed, true);
});

test('probe failures mark the attempted check failed and distinguish corruption from redirects', async () => {
    let deleted = 0, mode = 'redirect';
    const provider = { list: async () => ({}), ensureContainer: async () => {}, put: async () => {},
        get: async () => { if (mode === 'redirect') throw Object.assign(new Error('private signed URL'), { code: 'REDIRECT_REFUSED', status: 302 }); return Readable.from([Buffer.from('corrupt')]); },
        delete: async () => { deleted++; } };
    let result = await probe(provider);
    assert.equal(result.write, true); assert.equal(result.readback, false); assert.equal(result.delete, true);
    assert.deepEqual(result.error, { code: 'REDIRECT_REFUSED', status: 302 });
    mode = 'corrupt'; result = await probe(provider);
    assert.equal(result.readback, false); assert.equal(result.error.code, 'INTEGRITY_ERROR');
    assert.equal(deleted, 2);
    provider.put = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
    result = await probe(provider);
    assert.equal(result.write, false); assert.equal(result.readback, null);
    const readOnly = await probe(provider, { readOnly: true });
    assert.equal(readOnly.write, null); assert.equal(readOnly.readback, null);
});
