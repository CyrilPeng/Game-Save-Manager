const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const { validateConfig } = require('../src/main/cloud/config');
const { createWebDAV } = require('../src/main/cloud/providers/webdav');
const { createS3 } = require('../src/main/cloud/providers/s3');

async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        s.close(resolve);
        s.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${s.address().port}`;
}
const xml = (name, directory = false, size = 0, status = 200) =>
  `<d:response><d:href>${name}</d:href><d:propstat><d:prop><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 ${status} OK</d:status></d:propstat></d:response>`;
test('configuration separates secrets and rejects insecure/unsafe endpoints', () => {
  assert.throws(() =>
    validateConfig({ type: 'webdav', name: 'n', url: 'http://localhost' }),
  );
  assert.throws(() =>
    validateConfig({
      type: 'webdav',
      name: 'n',
      url: 'https://user:password@host',
    }),
  );
  assert.throws(() =>
    validateConfig({
      type: 'webdav',
      name: 'n',
      url: 'https://host',
      prefix: '../outside',
    }),
  );
  const c = validateConfig({
    type: 'webdav',
    name: 'n',
    url: 'https://host',
    password: 'never-persist',
  });
  assert.equal(c.password, undefined);
  assert.equal(c.proxy.mode, 'auto');
});
test('WebDAV ESM streams encoded names, scoped listing, roundtrip and deletion', async (t) => {
  const files = new Map();
  const paths = [];
  const url = await server(t, async (req, res) => {
    paths.push(req.url);
    const pathname = decodeURIComponent(req.url).replace(/\/$/, '');
    if (req.method === 'MKCOL') {
      res.writeHead(201);
      res.end();
    } else if (req.method === 'PUT') {
      const data = [];
      for await (const c of req) data.push(c);
      files.set(pathname, Buffer.concat(data));
      res.end();
    } else if (req.method === 'GET') {
      res.end(files.get(pathname));
    } else if (req.method === 'DELETE') {
      files.delete(pathname);
      res.writeHead(204);
      res.end();
    } else if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'content-type': 'application/xml' });
      const items =
        req.headers.depth === '0'
          ? xml(pathname, !files.has(pathname), files.get(pathname)?.length)
          : xml(pathname, true) +
            [...files]
              .filter(([key]) => key.startsWith(pathname + '/'))
              .map(([key, data]) => xml(encodeURI(key), false, data.length))
              .join('');
      res.end(`<d:multistatus xmlns:d="DAV:">${items}</d:multistatus>`);
    } else {
      res.writeHead(405);
      res.end();
    }
  });
  const p = await createWebDAV(
    validateConfig({
      type: 'webdav',
      name: 'test',
      url,
      prefix: '存档 space',
      allowInsecureHttp: true,
      proxy: { mode: 'direct' },
    }),
  );
  t.after(() => p.close());
  const data = Buffer.from('verified payload');
  const key = 'gsm/test space.bin';
  await p.put(key, { body: Readable.from([data]), size: data.length });
  assert.equal((await p.stat(key)).size, data.length);
  assert.deepEqual((await p.list('gsm/')).items, [{ key, size: data.length }]);
  const downloaded = [];
  for await (const chunk of await p.get(key)) downloaded.push(chunk);
  assert.deepEqual(Buffer.concat(downloaded), data);
  assert.ok(paths.some((p) => p.includes('%E5%AD%98%E6%A1%A3%20space')));
  await p.delete(key);
  assert.equal(files.size, 0);
});
test('WebDAV rejects redirects and individual 207 failures', async (t) => {
  let mode = 'redirect';
  const url = await server(t, (_req, res) => {
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/leak' });
      res.end();
    } else {
      res.writeHead(207);
      res.end(
        `<d:multistatus xmlns:d="DAV:">${xml('/gsm', true)}${xml('/gsm/forbidden', false, 0, 403)}</d:multistatus>`,
      );
    }
  });
  const p = await createWebDAV(
    validateConfig({
      type: 'webdav',
      name: 'test',
      url,
      allowInsecureHttp: true,
      proxy: { mode: 'direct' },
    }),
    { username: 'a', password: 'secret' },
  );
  t.after(() => p.close());
  await assert.rejects(p.get('gsm/a'), { code: 'REDIRECT_REFUSED' });
  mode = 'multistatus';
  await assert.rejects(p.list('gsm/'), (e) => e.status === 403);
});

test('WebDAV distinguishes a missing directory from a child 404 in a successful multistatus', async (t) => {
  let missingDirectory = false;
  const url = await server(t, (_req, res) => {
    if (missingDirectory) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(207);
    res.end(
      `<d:multistatus xmlns:d="DAV:">${xml('/gsm', true)}${xml('/gsm/valid', false, 3)}${xml('/gsm/missing', false, 0, 404)}</d:multistatus>`,
    );
  });
  const provider = await createWebDAV(
    validateConfig({
      type: 'webdav',
      name: 'test',
      url,
      allowInsecureHttp: true,
      proxy: { mode: 'direct' },
    }),
  );
  t.after(() => provider.close());
  await assert.rejects(provider.list('gsm/'), {
    code: 'MULTISTATUS_FAILED',
    status: 404,
  });
  await assert.rejects(provider.stat('gsm/valid'), {
    code: 'MULTISTATUS_FAILED',
    status: 404,
  });
  missingDirectory = true;
  assert.deepEqual((await provider.list('gsm/')).items, []);
  assert.equal(await provider.stat('gsm/valid'), null);
});
test('S3 SDK signs scoped requests and paginates without interpreting ETags as hashes', async (t) => {
  const requests = [];
  const contents = new Map();
  const url = await server(t, async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    requests.push({
      path: u.pathname,
      search: u.searchParams,
      auth: req.headers.authorization,
    });
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      contents.set(u.pathname, Buffer.concat(chunks));
      res.end();
    } else if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-length': contents.get(u.pathname)?.length || 0,
        etag: 'not-a-content-hash',
      });
      res.end();
    } else if (req.method === 'DELETE') {
      contents.delete(u.pathname);
      res.writeHead(204);
      res.end();
    } else if (u.searchParams.has('list-type')) {
      res.setHeader('content-type', 'application/xml');
      res.end(
        '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next-page</NextContinuationToken><Contents><Key>prefix/gsm/a</Key><Size>3</Size></Contents></ListBucketResult>',
      );
    } else res.end(contents.get(u.pathname));
  });
  const p = createS3(
    validateConfig({
      type: 's3',
      name: 'test',
      endpoint: url,
      region: 'custom-1',
      bucket: 'test-bucket',
      prefix: 'prefix',
      allowInsecureHttp: true,
      proxy: { mode: 'direct' },
    }),
    { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  );
  t.after(() => p.close());
  await p.put('gsm/a', { body: Readable.from([Buffer.from('abc')]), size: 3 });
  assert.equal((await p.stat('gsm/a')).size, 3);
  assert.equal((await p.list('gsm/')).cursor, 'next-page');
  const data = [];
  for await (const c of await p.get('gsm/a')) data.push(c);
  assert.equal(Buffer.concat(data).toString(), 'abc');
  await p.delete('gsm/a');
  assert.equal(contents.size, 0);
  assert.ok(
    requests.every(
      (r) =>
        r.auth.includes('AWS4-HMAC-SHA256') && r.auth.includes('/custom-1/s3/'),
    ),
  );
  assert.ok(requests.every((r) => r.path.startsWith('/test-bucket')));
});
test('S3 multipart records its ID, aborts on failure, and bounds part size', async () => {
  const calls = [];
  const records = [];
  const client = {
    async send(command) {
      calls.push(command);
      const name = command.constructor.name;
      if (name === 'CreateMultipartUploadCommand')
        return { UploadId: 'known-id' };
      if (name === 'UploadPartCommand') {
        if (command.input.PartNumber === 2) throw new Error('injected');
        return { ETag: 'part-one' };
      }
      return {};
    },
    destroy() {},
  };
  const p = createS3(
    { bucket: 'b', prefix: 'p', proxy: { mode: 'direct' } },
    { accessKeyId: 'k', secretAccessKey: 's' },
    { client, multipartThreshold: 1, partSize: 4 },
  );
  await assert.rejects(
    p.put('gsm/a', {
      body: Readable.from([Buffer.from('abcdefghij')]),
      size: 10,
      onMultipart: (r) => records.push(r),
    }),
    /injected/,
  );
  assert.equal(calls.at(-1).constructor.name, 'AbortMultipartUploadCommand');
  assert.equal(calls.at(-1).input.UploadId, 'known-id');
  assert.equal(records[0].uploadId, 'known-id');
  assert.equal(records.at(-1), null);
  p.close();
});

test('S3 failed abort keeps the recorded upload ID for durable queue cleanup', async () => {
  const records = [];
  const client = {
    async send(command) {
      if (command.constructor.name === 'CreateMultipartUploadCommand')
        return { UploadId: 'residual-upload' };
      if (command.constructor.name === 'UploadPartCommand')
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      if (command.constructor.name === 'AbortMultipartUploadCommand')
        throw Object.assign(new Error('forbidden'), { name: 'AccessDenied' });
      throw new Error('Unexpected request');
    },
    destroy() {},
  };
  const provider = createS3(
    { bucket: 'b', prefix: 'p', proxy: { mode: 'direct' } },
    { accessKeyId: 'key', secretAccessKey: 'secret' },
    { client, multipartThreshold: 1, partSize: 4 },
  );
  try {
    await assert.rejects(
      provider.put('gsm/save', {
        body: Readable.from([Buffer.from('abcdefgh')]),
        size: 8,
        onMultipart: (value) => records.push(value),
      }),
      { name: 'AbortError' },
    );
    assert.deepEqual(records, [
      { key: 'gsm/save', uploadId: 'residual-upload' },
    ]);
  } finally {
    provider.close();
  }
});
