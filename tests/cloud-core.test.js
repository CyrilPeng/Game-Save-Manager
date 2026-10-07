const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { CloudStore } = require('../src/main/cloud/store');
const { CredentialStore } = require('../src/main/cloud/credentials');
const {
  PersistentQueue,
  Semaphore,
  classifyError,
} = require('../src/main/cloud/queue');
const { CloudRepository } = require('../src/main/cloud/repository');
const { registerCloudIpc, validateInput } = require('../src/main/cloud/ipc');
const { snapshotPrefix } = require('../src/main/cloud/format');
const { CloudService, frozenMetadata } = require('../src/main/cloud/service');

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-cloud-core-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function until(predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for task');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('connection read capability follows readback and returns a sanitized redirect failure', async (t) => {
  const h = await realHarness(t),
    service = await h.newService('probe-result');
  const target = await h.target(service);
  h.provider.probe = async () => ({
    authentication: true,
    list: true,
    write: true,
    readback: false,
    delete: true,
    error: {
      code: 'REDIRECT_REFUSED',
      status: 302,
      message: 'https://secret:password@host/?signed=PRIVATE',
    },
  });
  const report = await service.testConnection({ targetId: target.id });
  assert.equal(report.readback, false);
  assert.equal(report.error.code, 'REDIRECT_REFUSED');
  assert.equal(report.error.status, 302);
  assert.equal((await service.target(target.id)).capabilities.read, false);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  h.provider.probe = async () => ({
    authentication: true,
    list: true,
    write: true,
    readback: true,
    delete: true,
  });
  await service.testConnection({ targetId: target.id });
  assert.equal((await service.target(target.id)).capabilities.read, true);
});

test('changed storage hides old versions, rejects stale actions and discards an in-flight old listing', async (t) => {
  const h = await realHarness(t),
    service = await h.newService('location');
  const target = await h.target(service),
    snapshot = await h.snapshot(service);
  const upload = await h.completed(
    service,
    await service.upload({
      targetId: target.id,
      gameId: '42',
      folder: snapshot.folder,
    }),
  );
  const version = (await service.getState()).versions[0];
  const entered = deferred(),
    release = deferred();
  const list = h.provider.list.bind(h.provider);
  h.provider.list = async (...args) => {
    entered.resolve();
    await release.promise;
    return list(...args);
  };
  const refreshing = service.refresh({ targetId: target.id });
  const rejectedRefresh = assert.rejects(refreshing, { code: 'NOT_FOUND' });
  await entered.promise;
  await service.saveTarget({
    config: { ...target, url: 'https://new-location.example' },
  });
  release.resolve();
  await rejectedRefresh;
  assert.equal((await service.getState()).versions.length, 0);
  assert.equal((await service.store.list('versions')).length, 0);
  // Also protect users upgrading with a stale cache from an earlier build.
  await service.store.put(
    'versions',
    `${target.id}:${version.versionId}`,
    version,
  );
  assert.equal((await service.getState()).versions.length, 0);
  for (const action of ['deleteVersion', 'download', 'restore'])
    await assert.rejects(
      service[action]({ targetId: target.id, versionId: version.versionId }),
      { code: 'NOT_FOUND' },
    );
  await service.cacheVersion(upload, version.manifest);
  assert.equal((await service.getState()).versions.length, 0);
  // A mirrored repository may contain the same version ID at the new host.
  const current = await service.target(target.id);
  await service.store.put('versions', `${target.id}:${version.versionId}`, {
    ...version,
    revision: current.revision,
  });
  for (const action of ['deleteVersion', 'download', 'restore'])
    await assert.rejects(
      service[action]({
        targetId: target.id,
        versionId: version.versionId,
        revision: version.revision,
      }),
      { code: 'NOT_FOUND' },
    );
  assert.ok(!h.provider.calls.some(([method]) => method === 'delete'));
});

test('repository selection invalidates history while renames preserve history and current read-only policy', async (t) => {
  const h = await realHarness(t),
    service = await h.newService('repository-change');
  const target = await h.target(service),
    snapshot = await h.snapshot(service);
  await h.completed(
    service,
    await service.upload({
      targetId: target.id,
      gameId: '42',
      folder: snapshot.folder,
    }),
  );
  const version = (await service.getState()).versions[0];
  const readonly = await service.saveTarget({
    config: { ...target, name: 'Renamed', readOnly: true },
  });
  assert.equal((await service.getState()).versions.length, 1);
  await assert.rejects(
    service.deleteVersion({
      targetId: target.id,
      versionId: version.versionId,
    }),
    { code: 'READ_ONLY' },
  );
  await service.saveTarget({
    config: { ...readonly, repositoryId: randomUUID() },
  });
  assert.equal((await service.getState()).versions.length, 0);
  await assert.rejects(
    service.download({ targetId: target.id, versionId: version.versionId }),
    { code: 'NOT_FOUND' },
  );
});

test('credential retention changes without retyping secrets and empty S3 tokens survive reopening', async (t) => {
  const h = await realHarness(t);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  };
  const service = await h.newService('retention', { safeStorage });
  const config = {
    type: 's3',
    name: 'R2',
    endpoint: 'https://storage.example',
    bucket: 'bucket',
    region: 'auto',
  };
  const target = await service.saveTarget({
    config,
    secrets: {
      accessKeyId: 'old-key',
      secretAccessKey: 'old-secret',
      sessionToken: 'expired-token',
    },
  });
  const reference = (await service.target(target.id)).credentialRef;
  await service.saveTarget({
    config: target,
    secrets: {
      accessKeyId: 'new-key',
      secretAccessKey: 'new-secret',
      sessionToken: '',
    },
  });
  assert.equal((await service.credentials.get(reference)).sessionToken, '');
  await service.saveTarget({ config: target, secrets: {}, sessionOnly: true });
  assert.equal(service.credentials.status(reference).sessionOnly, true);
  assert.equal(
    (await service.credentials.get(reference)).accessKeyId,
    'new-key',
  );
  let reopened = await new CredentialStore(
    service.credentials.filename,
    safeStorage,
  ).open();
  assert.deepEqual(await reopened.get(reference), {});
  await reopened.close();
  // Internal repository saves must not accidentally persist session secrets.
  await service.saveTarget({
    config: { ...target, repositoryId: randomUUID() },
  });
  assert.equal(service.credentials.status(reference).sessionOnly, true);
  await service.saveTarget({ config: target, secrets: {}, sessionOnly: false });
  reopened = await new CredentialStore(
    service.credentials.filename,
    safeStorage,
  ).open();
  assert.equal((await reopened.get(reference)).sessionToken, '');
  await reopened.close();
});

test('cancelled S3 uploads retain a durable cleanup task across failure and restart without uploading again', async (t) => {
  const h = await realHarness(t),
    store = new CloudStore(path.join(h.root, 'cleanup.db'));
  let denied = true,
    aborts = 0,
    uploads = 0;
  const createProvider = async () => ({
    close() {},
    abortMultipart: async (key, id) => {
      assert.equal(key, 'gsm/known-payload');
      assert.equal(id, 'known-upload');
      aborts++;
      if (denied) throw Object.assign(new Error('denied'), { status: 403 });
    },
  });
  const service = await h.newService('cleanup', { store, createProvider });
  service.queue.stopping = true;
  const target = await h.target(service);
  const id = randomUUID();
  await service.queue.add({
    id,
    kind: 'upload',
    targetId: target.id,
    revision: target.revision,
    multipart: { key: 'gsm/known-payload', uploadId: 'known-upload' },
  });
  service.runUpload = () => {
    uploads++;
    throw new Error('cancelled upload restarted');
  };
  await service.controlJob({ jobId: id, action: 'cancel' });
  assert.equal(
    service.publicJob(service.queue.jobs.get(id)).cleanupPending,
    true,
  );
  service.queue.start();
  await until(() => service.queue.jobs.get(id).stage === 'failed');
  assert.equal(
    service.publicJob(service.queue.jobs.get(id)).error.code,
    'ACCESS_DENIED',
  );
  await service.close();
  denied = false;
  const restarted = await h.newService('cleanup', { store, createProvider });
  restarted.runUpload = service.runUpload;
  await until(() => restarted.queue.jobs.get(id).stage === 'cancelled');
  assert.equal(restarted.queue.jobs.get(id).multipart, null);
  assert.equal(
    restarted.publicJob(restarted.queue.jobs.get(id)).cleanupPending,
    false,
  );
  assert.equal(aborts, 2);
  assert.equal(uploads, 0);
});

test('cancellation checkpoints an upload ID returned after abort and recovers older cancelled records', async () => {
  const store = memoryStore(),
    entered = deferred(),
    release = deferred();
  const queue = new PersistentQueue(store, async (_job, context) => {
    entered.resolve();
    await release.promise;
    await context.checkpointMultipart({ key: 'gsm/late', uploadId: 'late-id' });
    await context.update({ stage: 'uploading' });
  });
  await queue.initialize();
  const id = randomUUID();
  await queue.add({ id, kind: 'upload' });
  queue.start();
  await entered.promise;
  const cancelling = queue.control(id, 'cancel');
  await until(() => queue.active.get(id).controller.signal.aborted);
  queue.stopping = true;
  release.resolve();
  await cancelling;
  const saved = await store.get('jobs', id);
  assert.equal(saved.multipart.uploadId, 'late-id');
  assert.equal(saved.cleanupOnly, true);
  assert.equal(saved.cancelRequested, true);
  await queue.close();
  await store.put('jobs', id, {
    ...saved,
    stage: 'cancelled',
    cleanupOnly: undefined,
    cancelRequested: undefined,
  });
  const restarted = new PersistentQueue(store, async () => {});
  await restarted.initialize();
  assert.equal(restarted.jobs.get(id).stage, 'pending');
  assert.equal(restarted.jobs.get(id).cleanupOnly, true);
  await restarted.close();

  const slowStore = memoryStore(),
    saving = deferred(),
    durable = deferred(),
    failWorker = deferred(),
    workerFailed = deferred();
  const put = slowStore.put.bind(slowStore);
  slowStore.put = async (collection, key, value) => {
    if (value.cancelRequested && !value.cleanupOnly) {
      saving.resolve();
      await durable.promise;
    }
    return put(collection, key, value);
  };
  const racing = new PersistentQueue(slowStore, async () => {
    await failWorker.promise;
    workerFailed.resolve();
    throw new Error('network failed during cancellation write');
  });
  await racing.initialize();
  await racing.add({
    id,
    kind: 'upload',
    multipart: { key: 'gsm/late', uploadId: 'late-id' },
  });
  racing.start();
  await until(() => racing.active.has(id));
  const cancelDuringWrite = racing.control(id, 'cancel');
  await saving.promise;
  failWorker.resolve();
  await workerFailed.promise;
  racing.stopping = true;
  durable.resolve();
  await cancelDuringWrite;
  assert.equal(racing.jobs.get(id).stage, 'pending');
  assert.equal(racing.jobs.get(id).cleanupOnly, true);
  await racing.close();
});

function memoryStore() {
  const values = new Map();
  return {
    open: async () => {},
    close: async () => {},
    get: async (collection, id) => values.get(`${collection}:${id}`) || null,
    list: async (collection) =>
      [...values]
        .filter(([key]) => key.startsWith(`${collection}:`))
        .map(([, value]) => structuredClone(value)),
    put: async (collection, id, value) => {
      values.set(`${collection}:${id}`, structuredClone(value));
    },
    delete: async (collection, id) => {
      values.delete(`${collection}:${id}`);
    },
    async batch(operations) {
      for (const operation of operations)
        if (operation.delete)
          await this.delete(operation.collection, operation.id);
        else
          await this.put(operation.collection, operation.id, operation.value);
    },
  };
}

function memoryProvider() {
  const objects = new Map();
  const calls = [];
  const provider = {
    objects,
    calls,
    capabilities: { conditionalCreate: true },
    async list(prefix, { cursor } = {}) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const offset = Number(cursor || 0);
      return {
        items: keys
          .slice(offset, offset + 2)
          .map((key) => ({ key, size: objects.get(key).length })),
        cursor: keys.length > offset + 2 ? String(offset + 2) : null,
      };
    },
    async stat(key) {
      return objects.has(key)
        ? { size: objects.get(key).length, etag: 'not-a-content-hash' }
        : null;
    },
    async put(key, { body, ifAbsent }) {
      calls.push(['put', key]);
      if (ifAbsent && objects.has(key))
        throw Object.assign(new Error('exists'), { status: 412 });
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      if (provider.corruptPayload && key.endsWith('.gsmr'))
        objects.get(key)[0] ^= 255;
      if (provider.loseResponse?.(key))
        throw Object.assign(new Error('credential and URL must never escape'), {
          code: 'ECONNRESET',
        });
    },
    async get(key) {
      calls.push(['get', key]);
      if (!objects.has(key))
        throw Object.assign(new Error('missing'), { status: 404 });
      return Readable.from(objects.get(key));
    },
    async delete(key) {
      calls.push(['delete', key]);
      if (provider.failDelete)
        throw Object.assign(new Error('offline'), { code: 'ECONNRESET' });
      objects.delete(key);
    },
    async ensureContainer() {},
    close() {},
  };
  return provider;
}

function manifestFixture(buffer = Buffer.from('game save bytes')) {
  const repositoryId = randomUUID(),
    deviceId = randomUUID(),
    snapshotId = randomUUID();
  const digest = createHash('sha256').update(buffer).digest('hex');
  const manifest = {
    schemaVersion: 1,
    minimumReaderVersion: 1,
    repositoryId,
    publisherDeviceId: deviceId,
    originDeviceId: deviceId,
    snapshotId,
    gameKey: 'pcgw:42',
    title: '<img src=x onerror=alert(1)>',
    createdAt: '2026-10-04T00:00:00.000Z',
    uploadedAt: '2026-10-05T00:00:00.000Z',
    archiveSize: buffer.length,
    archiveSha256: digest,
    contentHash: digest,
    unpackedSize: 22,
    fileCount: 2,
    backup_paths: [
      { folder_name: 'path1', template: '{{p|appdata}}/Test', type: 'folder' },
    ],
  };
  manifest.archiveKey = `${snapshotPrefix(repositoryId, deviceId, manifest.gameKey, snapshotId)}/payload-${digest}.gsmr`;
  return {
    manifest,
    buffer,
    config: { repositoryId },
    device: { id: deviceId, name: 'test device' },
  };
}

test('SQLite commits task batches durably and reopening preserves configuration revisions', async (t) => {
  const directory = await temporary(t),
    filename = path.join(directory, 'cloud.db');
  const store = await new CloudStore(filename).open();
  await store.batch([
    { collection: 'jobs', id: '1', value: { stage: 'uploading' } },
    {
      collection: 'revisions',
      id: 'target:1',
      value: { endpoint: 'https://old.example' },
    },
  ]);
  await store.close();
  const reopened = await new CloudStore(filename).open();
  assert.equal((await reopened.get('jobs', '1')).stage, 'uploading');
  assert.equal(
    (await reopened.list('revisions'))[0].endpoint,
    'https://old.example',
  );
  await reopened.close();
});

test('protected credentials never persist plaintext and unavailable storage remains session-only', async (t) => {
  const directory = await temporary(t);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 177)),
    decryptString: (value) =>
      Buffer.from([...value].map((byte) => byte ^ 177)).toString(),
  };
  const filename = path.join(directory, 'credentials.json');
  const credentials = await new CredentialStore(filename, safeStorage).open();
  await credentials.set('target', {
    secretAccessKey: 'VERY_SECRET_KEY',
    sessionToken: 'PRIVATE_TOKEN',
  });
  assert.equal(
    (await credentials.get('target')).secretAccessKey,
    'VERY_SECRET_KEY',
  );
  assert.ok(!(await fs.readFile(filename, 'utf8')).includes('VERY_SECRET_KEY'));
  const session = await new CredentialStore(
    path.join(directory, 'session.json'),
    { isEncryptionAvailable: () => false },
  ).open();
  await session.set('target', { password: 'NEVER_PERSIST' });
  assert.equal(session.status('target').sessionOnly, true);
  await assert.rejects(fs.readFile(path.join(directory, 'session.json')), {
    code: 'ENOENT',
  });
  await session.close();
  assert.deepEqual(await session.get('target'), {});
  const weak = new CredentialStore(path.join(directory, 'weak.json'), {
    ...safeStorage,
    getSelectedStorageBackend: () => 'basic_text',
  });
  assert.equal(weak.canPersist(), false);
});

test('corrupt protected credential store is not silently overwritten', async (t) => {
  const directory = await temporary(t),
    filename = path.join(directory, 'credentials.json');
  await fs.writeFile(filename, '{broken');
  await assert.rejects(new CredentialStore(filename).open(), {
    code: 'CREDENTIALS_UNAVAILABLE',
  });
  assert.equal(await fs.readFile(filename, 'utf8'), '{broken');
});

test('queue restarts interrupted tasks, limits workers and retries only transient errors', async () => {
  const store = memoryStore();
  await store.put('jobs', 'old', {
    id: 'old',
    stage: 'committing',
    attempts: 1,
  });
  let active = 0,
    peak = 0;
  const seen = new Map();
  const queue = new PersistentQueue(
    store,
    async (job) => {
      active++;
      peak = Math.max(peak, active);
      try {
        seen.set(job.id, (seen.get(job.id) || 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 8));
        if (job.id === 'transient' && seen.get(job.id) === 1)
          throw Object.assign(
            new Error('https://secret-user:secret-password@host'),
            { status: 503 },
          );
        if (job.id === 'auth')
          throw Object.assign(new Error('SECRET_TOKEN'), { status: 403 });
      } finally {
        active--;
      }
    },
    { retryBaseMs: 1 },
  );
  await queue.initialize();
  assert.equal(queue.jobs.get('old').stage, 'pending');
  for (const id of ['transient', 'auth', 'third']) await queue.add({ id });
  queue.start();
  await until(
    () =>
      queue.jobs.get('transient').stage === 'succeeded' &&
      queue.jobs.get('auth').stage === 'failed' &&
      queue.jobs.get('third').stage === 'succeeded',
  );
  assert.equal(peak, 2);
  assert.equal(seen.get('transient'), 2);
  assert.equal(seen.get('auth'), 1);
  assert.ok(!JSON.stringify(await store.list('jobs')).includes('SECRET_TOKEN'));
  assert.equal(queue.jobs.get('auth').error.code, 'ACCESS_DENIED');
  await queue.close();
});

test('queue pause and cancel abort active work and cancellation releases reservation', async () => {
  const store = memoryStore();
  const queue = new PersistentQueue(store, async (job, { signal, update }) => {
    await update({ stage: 'uploading' });
    await new Promise((resolve, reject) =>
      signal.addEventListener(
        'abort',
        () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      ),
    );
  });
  await queue.initialize();
  await queue.add({ id: 'control', reservationBytes: 100 });
  queue.start();
  await until(() => queue.jobs.get('control').stage === 'uploading');
  await queue.control('control', 'pause');
  assert.equal(queue.jobs.get('control').stage, 'paused');
  await queue.control('control', 'resume');
  await until(() => queue.jobs.get('control').stage === 'uploading');
  await queue.control('control', 'cancel');
  assert.equal(queue.jobs.get('control').stage, 'cancelled');
  assert.equal(queue.jobs.get('control').reservationBytes, 0);
  await queue.close();
});

test('restart never automatically repeats live restore writes and active restore cannot be cancelled midway', async () => {
  const store = memoryStore();
  await store.put('jobs', 'restore', {
    id: 'restore',
    kind: 'restore',
    stage: 'restoring',
    attempts: 1,
  });
  let executions = 0,
    finish;
  const queue = new PersistentQueue(store, async (_job, { update }) => {
    executions++;
    await update({ stage: 'restoring' });
    await new Promise((resolve) => {
      finish = resolve;
    });
  });
  await queue.initialize();
  queue.start();
  assert.equal(queue.jobs.get('restore').stage, 'failed');
  assert.equal(queue.jobs.get('restore').error.code, 'RESTORE_FAILED');
  assert.equal(executions, 0);
  await queue.control('restore', 'retry');
  await until(() => queue.jobs.get('restore').stage === 'restoring');
  await assert.rejects(queue.control('restore', 'cancel'), {
    code: 'ACTIVE_JOBS',
  });
  await assert.rejects(queue.control('restore', 'pause'), {
    code: 'ACTIVE_JOBS',
  });
  finish();
  await until(() => queue.jobs.get('restore').stage === 'succeeded');
  await queue.close();
});

test('packaging semaphore admits one operation and aborted waiters never acquire it', async () => {
  const semaphore = new Semaphore(1);
  let release;
  const first = semaphore.use(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const second = semaphore.use(
    () => assert.fail('cancelled waiter ran'),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(second, { code: 'CANCELLED' });
  release();
  await first;
  assert.equal(semaphore.count, 0);
});

test('corrupt uploaded payload cannot publish a manifest even with an ETag', async (t) => {
  const directory = await temporary(t),
    fixture = manifestFixture(),
    provider = memoryProvider();
  const file = path.join(directory, 'payload.gsmr');
  await fs.writeFile(file, fixture.buffer);
  provider.corruptPayload = true;
  const repository = new CloudRepository(
    provider,
    fixture.config,
    fixture.device,
  );
  await assert.rejects(repository.publish(fixture.manifest, file), {
    code: 'INTEGRITY_ERROR',
  });
  assert.ok(
    ![...provider.objects.keys()].some((key) => key.endsWith('/manifest.json')),
  );
});

test('lost upload and commit responses recover through verified remote reads', async (t) => {
  const directory = await temporary(t),
    fixture = manifestFixture(),
    provider = memoryProvider();
  const file = path.join(directory, 'payload.gsmr');
  await fs.writeFile(file, fixture.buffer);
  provider.loseResponse = (key) =>
    key.endsWith('.gsmr') || key.endsWith('/manifest.json');
  const repository = new CloudRepository(
    provider,
    fixture.config,
    fixture.device,
  );
  const committed = await repository.publish(fixture.manifest, file);
  assert.equal(committed.archiveSha256, fixture.manifest.archiveSha256);
  const puts = provider.calls.filter((call) => call[0] === 'put').length;
  await repository.publish(fixture.manifest, file);
  assert.equal(provider.calls.filter((call) => call[0] === 'put').length, puts);
  const otherDevice = new CloudRepository(provider, fixture.config, {
    id: randomUUID(),
    name: 'new computer',
  });
  assert.equal((await otherDevice.discover()).length, 1);
  assert.equal((await otherDevice.browse()).manifests.length, 1);
});

test('deletion failure retains tombstone, hides the version and prevents resurrection', async (t) => {
  const directory = await temporary(t),
    fixture = manifestFixture(),
    provider = memoryProvider();
  const file = path.join(directory, 'payload.gsmr');
  await fs.writeFile(file, fixture.buffer);
  const repository = new CloudRepository(
    provider,
    fixture.config,
    fixture.device,
  );
  await repository.publish(fixture.manifest, file);
  provider.failDelete = true;
  await assert.rejects(repository.delete(fixture.manifest), {
    code: 'ECONNRESET',
  });
  assert.equal((await repository.browse()).manifests.length, 0);
  await assert.rejects(repository.publish(fixture.manifest, file), {
    code: 'SNAPSHOT_DELETED',
  });
  provider.failDelete = false;
  await repository.delete(fixture.manifest);
  assert.equal(provider.objects.size, 2); // device discovery file and durable tombstone
});

test('read-only repositories reject all writes and corrupted downloads never become complete files', async (t) => {
  const directory = await temporary(t),
    fixture = manifestFixture(),
    provider = memoryProvider();
  const repository = new CloudRepository(
    provider,
    { ...fixture.config, readOnly: true },
    fixture.device,
  );
  await assert.rejects(repository.create(), { code: 'READ_ONLY' });
  await assert.rejects(repository.delete(fixture.manifest), {
    code: 'READ_ONLY',
  });
  provider.objects.set(
    `${repository.prefix(fixture.manifest)}/manifest.json`,
    Buffer.from(JSON.stringify(fixture.manifest)),
  );
  provider.objects.set(fixture.manifest.archiveKey, Buffer.from('bad'));
  const output = path.join(directory, 'download.gsmr');
  await assert.rejects(repository.download(fixture.manifest, output), {
    code: 'INTEGRITY_ERROR',
  });
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${output}.partial`), { code: 'ENOENT' });
});

test('IPC rejects foreign windows, subframes and arbitrary paths and sanitizes provider errors', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const frame = { url: 'file:///trusted/index.html' },
    contents = { mainFrame: frame };
  const service = new Proxy(
    {},
    {
      get: () => async () => {
        throw Object.assign(
          new Error('https://KEY:SECRET@host?token=PRIVATE'),
          { status: 403 },
        );
      },
    },
  );
  const unregister = registerCloudIpc(ipcMain, service, {
    getTrustedWebContents: () => contents,
    trustedURL: frame.url,
  });
  assert.equal(
    (await handlers.get('cloud:getState')({ sender: {}, senderFrame: frame }))
      .error.code,
    'UNTRUSTED_SENDER',
  );
  assert.equal(
    (
      await handlers.get('cloud:getState')({
        sender: contents,
        senderFrame: { ...frame },
      })
    ).error.code,
    'UNTRUSTED_SENDER',
  );
  const rejected = await handlers.get('cloud:getState')({
    sender: contents,
    senderFrame: frame,
  });
  assert.equal(rejected.error.code, 'ACCESS_DENIED');
  assert.ok(!JSON.stringify(rejected).includes('SECRET'));
  assert.throws(() => validateInput('upload', { folder: '../escape' }), {
    code: 'INVALID_REQUEST',
  });
  assert.throws(() => validateInput('download', { localPath: 'C:/Windows' }), {
    code: 'INVALID_REQUEST',
  });
  unregister();
  assert.equal(handlers.size, 0);
});

test('metadata whitelist removes settings, intents and unrelated custom definition fields', () => {
  const metadata = {
    schemaVersion: 1,
    title: 'Game',
    backup_paths: [
      { folder_name: 'path1', template: 'save', type: 'folder', secret: 'NO' },
    ],
    password: 'NO',
    settings: { secretKey: 'NO' },
    cloudUploadIntent: { targetId: 'NO' },
    customDefinition: {
      title: 'Game',
      wiki_page_id: randomUUID(),
      settings: { secret: 'NO' },
      save_location: {
        win: [{ template: 'save', type: 'folder', password: 'NO' }],
      },
    },
  };
  assert.ok(!JSON.stringify(frozenMetadata(metadata)).includes('NO'));
});

test('cloud service pins accepted sources, freezes target revisions and enforces cache budget', async (t) => {
  const directory = await temporary(t),
    fixture = manifestFixture();
  const backup = path.join(directory, 'backups'),
    snapshotPath = path.join(backup, '42', 'version');
  await fs.mkdir(snapshotPath, { recursive: true });
  await fs.writeFile(path.join(snapshotPath, 'save.dat'), 'bytes');
  const metadata = { ...fixture.manifest, backup_size: 5 };
  delete metadata.archiveKey;
  const snapshot = {
    root: backup,
    gameId: '42',
    gameKey: 'pcgw:42',
    folder: 'version',
    path: snapshotPath,
    snapshotId: metadata.snapshotId,
    createdAt: metadata.createdAt,
    metadata,
  };
  let pins = 0,
    libraryBusy = false;
  const snapshotStore = {
    listSnapshots: async () => [],
    readSnapshot: async () => snapshot,
    ensureIdentity: async (value) => value,
  };
  const service = new CloudService({
    userDataPath: directory,
    getBackupPath: () => backup,
    store: memoryStore(),
    snapshotStore,
    archive: {},
    safeStorage: { isEncryptionAvailable: () => false },
    coordinator: {
      isLibraryBusy: () => libraryBusy,
      protectSnapshot: () => {
        pins++;
        return () => pins--;
      },
      setCommitHook() {},
      setIntentProvider() {},
    },
  });
  await service.initialize();
  service.queue.stopping = true;
  const first = await service.saveTarget({
    config: {
      type: 'webdav',
      name: 'NAS',
      url: 'https://old.example',
      repositoryId: fixture.manifest.repositoryId,
    },
    secrets: { username: 'user', password: 'PRIVATE_SECRET' },
  });
  libraryBusy = true;
  await assert.rejects(
    service.upload({ targetId: first.id, gameId: '42', folder: 'version' }),
    { code: 'ACTIVE_JOBS' },
  );
  assert.equal(pins, 0);
  assert.equal(service.queue.jobs.size, 0);
  libraryBusy = false;
  const job = await service.upload({
    targetId: first.id,
    gameId: '42',
    folder: 'version',
  });
  assert.equal(pins, 1);
  assert.deepEqual(
    service.sourceUploadJobs(snapshotPath).map((value) => value.id),
    [job.id],
  );
  assert.deepEqual(
    service.sourceUploadJobs(path.join(backup, '42', 'other')),
    [],
  );
  await service.saveTarget({
    config: { ...first, url: 'https://new.example' },
    secrets: {},
  });
  assert.equal(
    (await service.target(first.id, job.revision)).config.url,
    'https://old.example',
  );
  assert.equal(
    (
      await service.credentials.get(
        (await service.target(first.id, job.revision)).credentialRef,
      )
    ).password,
    'PRIVATE_SECRET',
  );
  assert.deepEqual(
    await service.credentials.get(
      (await service.target(first.id)).credentialRef,
    ),
    {},
  );
  assert.ok(
    !JSON.stringify(await service.getState()).includes('PRIVATE_SECRET'),
  );
  service.cache.budgetBytes = 1;
  await assert.rejects(service.reserve(2), { code: 'SPACE_LIMIT' });
  await service.cancelSourceUploads(snapshotPath);
  assert.equal(service.queue.jobs.get(job.id).stage, 'cancelled');
  assert.deepEqual(service.sourceUploadJobs(snapshotPath), []);
  assert.equal(pins, 0);
  await service.close();
});

test('provider errors expose stable classifications without tokens or signed URLs', () => {
  assert.deepEqual(
    classifyError({ code: 'CERT_HAS_EXPIRED', message: 'SECRET' }),
    {
      code: 'CERTIFICATE_ERROR',
      message: '无法验证服务器证书。',
      retryable: false,
    },
  );
  assert.equal(classifyError({ status: 429 }).retryable, true);
  assert.equal(classifyError({ status: 507 }).retryable, false);
});

async function realHarness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-cloud-flow-'));
  const provider = memoryProvider();
  const services = [];
  const snapshots = require('../src/main/backup/snapshotStore');
  const archive = require('../src/main/backup/archive');
  t.after(async () => {
    for (const service of services) await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function newService(name, extra = {}) {
    const backupRoot = path.join(root, name, 'backups');
    await fs.mkdir(backupRoot, { recursive: true });
    const service = new CloudService({
      userDataPath: path.join(root, name),
      getBackupPath: () => backupRoot,
      createProvider: async () => provider,
      store: memoryStore(),
      snapshotStore: snapshots,
      archive,
      coordinator: {
        protectSnapshot: () => () => {},
        setCommitHook() {},
        setIntentProvider() {},
      },
      safeStorage: { isEncryptionAvailable: () => false },
      ...extra,
    });
    const execute = service.runJob.bind(service);
    service.runJob = async (...args) => {
      try {
        return await execute(...args);
      } catch (error) {
        service.testFailure = error;
        throw error;
      }
    };
    await service.initialize();
    services.push(service);
    return service;
  }
  async function snapshot(service, index = 0, extra = {}) {
    const id = randomUUID(),
      createdAt = new Date(Date.UTC(2026, 9, 5, 0, index)).toISOString();
    const folder = `${createdAt.replace(/[:.]/g, '-')}_${id}`;
    const directory = path.join(service.backupRoot(), '42', folder);
    await fs.mkdir(path.join(directory, 'path1'), { recursive: true });
    await fs.writeFile(
      path.join(directory, 'path1', 'save.dat'),
      'same logical game save',
    );
    await fs.writeFile(
      path.join(directory, 'backup_info.json'),
      JSON.stringify({
        schemaVersion: 1,
        minimumReaderVersion: 1,
        snapshotId: id,
        createdAt,
        title: 'Test Game',
        gameKey: 'pcgw:42',
        backup_paths: [
          {
            folder_name: 'path1',
            type: 'folder',
            template: '{{p|appdata}}/TestGame',
          },
        ],
        ...extra,
      }),
    );
    return snapshots.readSnapshot(service.backupRoot(), '42', folder);
  }
  async function target(service, repositoryId = randomUUID()) {
    return service.saveTarget({
      config: {
        type: 'webdav',
        name: 'Test storage',
        url: 'https://storage.example',
        repositoryId,
      },
    });
  }
  async function completed(service, job) {
    await until(
      () =>
        ['succeeded', 'failed'].includes(service.queue.jobs.get(job.id)?.stage),
      20000,
    );
    const result = service.queue.jobs.get(job.id);
    assert.equal(
      result.stage,
      'succeeded',
      service.testFailure?.stack || JSON.stringify(service.publicJob(result)),
    );
    return result;
  }
  return { root, provider, newService, snapshot, target, completed };
}

test(
  'migration admission covers upload reservation, durable queue commit and cancellation cleanup',
  { timeout: 10000 },
  async (t) => {
    const coordinator = require('../src/main/backup/backupCoordinator');
    const harness = await realHarness(t),
      service = await harness.newService('migration-upload', { coordinator });
    service.queue.stopping = true;
    const target = await harness.target(service);
    const source = await harness.snapshot(service, 0, {
      cloudUploadIntent: { targetId: target.id, state: 'pending' },
    });
    let currentRoot = service.backupRoot();
    service.options.getBackupPath = () => currentRoot;
    const movedRoot = path.join(harness.root, 'moved-backups');
    const migrate = () =>
      service.hasUnfinishedJobs()
        ? Promise.resolve(false)
        : coordinator.withLibraryLock(async () => {
            await fs.rename(currentRoot, movedRoot);
            currentRoot = movedRoot;
            return true;
          });
    const reserved = deferred(),
      releaseReservation = deferred(),
      committing = deferred(),
      releaseCommit = deferred();
    const cleaning = deferred(),
      releaseCleanup = deferred();
    const reserve = service.reserve.bind(service),
      put = service.store.put.bind(service.store),
      completeIntent = service.completeIntent.bind(service);
    service.reserve = async (bytes) => {
      reserved.resolve();
      await releaseReservation.promise;
      return reserve(bytes);
    };
    let firstWrite = true;
    service.store.put = async (...args) => {
      if (args[0] === 'jobs' && firstWrite) {
        firstWrite = false;
        committing.resolve();
        await releaseCommit.promise;
      }
      return put(...args);
    };
    service.completeIntent = async (...args) => {
      cleaning.resolve();
      await releaseCleanup.promise;
      return completeIntent(...args);
    };
    let acceptance, cancellation;
    try {
      acceptance = service.upload({
        targetId: target.id,
        gameId: '42',
        folder: source.folder,
      });
      assert.equal(service.hasUnfinishedJobs(), true);
      await reserved.promise;
      assert.equal(service.queue.jobs.size, 0);
      assert.equal(await migrate(), false);
      assert.equal(coordinator.isProtected(source.path), true);
      releaseReservation.resolve();
      await committing.promise;
      assert.equal(service.queue.jobs.size, 0);
      assert.equal(await migrate(), false);
      releaseCommit.resolve();
      const job = await acceptance;
      assert.equal(service.queue.jobs.get(job.id).stage, 'pending');
      assert.equal(await migrate(), false);
      cancellation = service.controlJob({ jobId: job.id, action: 'cancel' });
      await cleaning.promise;
      assert.equal(service.queue.jobs.get(job.id).stage, 'cancelled');
      assert.equal(service.hasUnfinishedJobs(), true);
      assert.equal(await migrate(), false);
      releaseCleanup.resolve();
      await cancellation;
      assert.equal(coordinator.isProtected(source.path), false);
      assert.equal(service.hasUnfinishedJobs(), false);
      assert.equal(await migrate(), true);
      const moved = await service.snapshots.readSnapshot(
        service.backupRoot(),
        '42',
        source.folder,
      );
      assert.equal(moved.metadata.cloudUploadIntent.state, 'completed');
      assert.equal(
        await fs.readFile(path.join(moved.path, 'path1', 'save.dat'), 'utf8'),
        'same logical game save',
      );
    } finally {
      releaseReservation.resolve();
      releaseCommit.resolve();
      releaseCleanup.resolve();
      await Promise.allSettled([acceptance, cancellation].filter(Boolean));
    }
  },
);

test(
  'download and restore acceptance block migration before persistence, and a reserved migration rejects new jobs',
  { timeout: 10000 },
  async (t) => {
    const coordinator = require('../src/main/backup/backupCoordinator');
    const harness = await realHarness(t),
      service = await harness.newService('migration-download', { coordinator });
    service.queue.stopping = true;
    const fixture = manifestFixture(),
      target = await harness.target(service, fixture.manifest.repositoryId);
    const versionId = fixture.manifest.archiveSha256;
    await service.store.put('versions', `${target.id}:${versionId}`, {
      versionId,
      targetId: target.id,
      revision: target.revision,
      manifest: fixture.manifest,
    });
    const source = await harness.snapshot(service);
    const reserve = service.reserve.bind(service);
    for (const kind of ['download', 'restore']) {
      const reserved = deferred(),
        release = deferred();
      service.reserve = async (bytes) => {
        reserved.resolve();
        await release.promise;
        return reserve(bytes);
      };
      let acceptance;
      try {
        acceptance = service[kind]({ targetId: target.id, versionId });
        assert.equal(service.hasUnfinishedJobs(), true);
        await reserved.promise;
        assert.equal(
          [...service.queue.jobs.values()].filter(
            (job) => !['cancelled', 'succeeded'].includes(job.stage),
          ).length,
          0,
        );
        assert.equal(service.pendingLibraryOperations > 0, true);
        release.resolve();
        const job = await acceptance;
        assert.equal(service.hasUnfinishedJobs(), true);
        await service.controlJob({ jobId: job.id, action: 'cancel' });
        assert.equal(service.hasUnfinishedJobs(), false);
      } finally {
        release.resolve();
        await Promise.allSettled([acceptance].filter(Boolean));
      }
    }
    const entered = deferred(),
      release = deferred();
    const migration = coordinator.withLibraryLock(async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      // withLibraryLock reserves synchronously, even before its callback runs.
      assert.equal(coordinator.isLibraryBusy(), true);
      await assert.rejects(
        service.upload({
          targetId: target.id,
          gameId: '42',
          folder: source.folder,
        }),
        { code: 'ACTIVE_JOBS' },
      );
      await assert.rejects(
        service.uploadMany({ targetId: target.id, selection: 'all' }),
        { code: 'ACTIVE_JOBS' },
      );
      await assert.rejects(
        service.download({ targetId: target.id, versionId }),
        { code: 'ACTIVE_JOBS' },
      );
      await assert.rejects(
        service.restore({ targetId: target.id, versionId }),
        { code: 'ACTIVE_JOBS' },
      );
      await entered.promise;
      assert.equal(service.hasUnfinishedJobs(), false);
      assert.equal(service.protections.size, 0);
    } finally {
      release.resolve();
      await migration;
    }
  },
);

test(
  'local commit holding the library read lock cannot deadlock behind a pending migration writer',
  { timeout: 10000 },
  async (t) => {
    const coordinator = require('../src/main/backup/backupCoordinator');
    const harness = await realHarness(t),
      service = await harness.newService('migration-hook', { coordinator });
    service.queue.stopping = true;
    const target = await harness.target(service);
    const source = await harness.snapshot(service, 0, {
      cloudUploadIntent: {
        targetId: target.id,
        revision: target.revision,
        jobId: randomUUID(),
        state: 'pending',
      },
    });
    const releaseMutation = deferred(),
      mutationEntered = deferred(),
      hookEntered = deferred();
    const blockedMutation = service.mutate(async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    });
    await mutationEntered.promise;
    let localCommit, migration;
    try {
      localCommit = coordinator.withGameLock('42', async () => {
        hookEntered.resolve();
        return service.onLocalCommit(source);
      });
      await hookEntered.promise;
      assert.equal(service.hasUnfinishedJobs(), true);
      let migrationRan = false;
      migration = coordinator.withLibraryLock(async () => {
        migrationRan = true;
      });
      assert.equal(coordinator.isLibraryBusy(), true);
      releaseMutation.resolve();
      await localCommit;
      await migration;
      assert.equal(migrationRan, true);
      assert.equal(service.hasUnfinishedJobs(), false);
      assert.equal(service.queue.jobs.size, 0);
      const completed = await service.snapshots.readSnapshot(
        service.backupRoot(),
        '42',
        source.folder,
      );
      assert.equal(completed.metadata.cloudUploadIntent.state, 'completed');
      assert.equal(
        completed.metadata.cloudUploadIntent.errorCode,
        'ACTIVE_JOBS',
      );
    } finally {
      releaseMutation.resolve();
      await Promise.allSettled(
        [blockedMutation, localCommit, migration].filter(Boolean),
      );
    }
  },
);

test('real archives upload, skip unchanged automatic saves, reupload deleted identities and download on a second device', async (t) => {
  const harness = await realHarness(t);
  const first = await harness.newService('first');
  await first.setDevice({ name: '客厅游戏电脑' });
  const target = await harness.target(first);
  const snapshot = await harness.snapshot(first);
  const uploaded = await harness.completed(
    first,
    await first.upload({
      targetId: target.id,
      gameId: '42',
      folder: snapshot.folder,
    }),
  );
  const repeated = await harness.completed(
    first,
    await first.upload({
      targetId: target.id,
      gameId: '42',
      folder: snapshot.folder,
    }),
  );
  assert.equal(repeated.result.alreadyCommitted, true);
  const sameContent = await harness.snapshot(first, 1);
  const automatic = await harness.completed(
    first,
    await first.enqueueSnapshot(sameContent, target.id, { automatic: true }),
  );
  assert.equal(automatic.result.duplicateContent, true);
  assert.equal(
    [...harness.provider.objects.keys()].filter((key) =>
      key.endsWith('/manifest.json'),
    ).length,
    1,
  );
  await harness.completed(
    first,
    await first.deleteVersion({
      targetId: target.id,
      versionId: uploaded.result.versionId,
    }),
  );
  const restoredCloud = await harness.completed(
    first,
    await first.upload({
      targetId: target.id,
      gameId: '42',
      folder: snapshot.folder,
    }),
  );
  assert.notEqual(restoredCloud.snapshotId, snapshot.snapshotId);
  assert.equal(restoredCloud.manifest.sourceSnapshotId, snapshot.snapshotId);
  const second = await harness.newService('second');
  const secondTarget = await harness.target(second, target.repositoryId);
  const listing = await second.refresh({ targetId: secondTarget.id });
  assert.equal(listing.versions.length, 1);
  assert.equal(listing.versions[0].deviceName, '客厅游戏电脑');
  assert.equal(
    (await second.getState()).versions[0].deviceName,
    '客厅游戏电脑',
  );
  assert.equal(listing.versions[0].manifest.deviceName, undefined);
  const downloaded = await harness.completed(
    second,
    await second.download({
      targetId: secondTarget.id,
      versionId: listing.versions[0].versionId,
    }),
  );
  const imported = await second.snapshots.readSnapshot(
    second.backupRoot(),
    '42',
    downloaded.result.folder,
  );
  assert.equal(imported.metadata.cloudImported, true);
  assert.equal(imported.metadata.cloudUploadIntent, undefined);
  assert.equal(
    await fs.readFile(path.join(imported.path, 'path1', 'save.dat'), 'utf8'),
    'same logical game save',
  );
});

test('cloud restore preserves verified local copy while mappings are confirmed through main-process selection', async (t) => {
  const harness = await realHarness(t);
  const uploader = await harness.newService('source');
  const target = await harness.target(uploader);
  const source = await harness.snapshot(uploader);
  const uploaded = await harness.completed(
    uploader,
    await uploader.upload({
      targetId: target.id,
      gameId: '42',
      folder: source.folder,
    }),
  );
  const chosen = path.join(harness.root, 'game-saves');
  let writes = 0;
  const receiver = await harness.newService('receiver', {
    chooseRestoreMapping: async () => chosen,
    restoreSnapshot: async (input) => {
      if (!input.mappings?.path1)
        return {
          error: 'mapping required',
          code: 'PATH_MAPPING_REQUIRED',
          mappingsRequired: [
            {
              folder: 'path1',
              type: 'folder',
              template: 'old device path',
              reason: 'account',
            },
          ],
        };
      assert.equal(input.mappings.path1, chosen);
      writes++;
      return { error: null, protectionSnapshotId: randomUUID() };
    },
  });
  const receiverTarget = await harness.target(receiver, target.repositoryId);
  await receiver.refresh({ targetId: receiverTarget.id });
  const job = await receiver.restore({
    targetId: receiverTarget.id,
    versionId: uploaded.result.versionId,
  });
  await until(() => receiver.queue.jobs.get(job.id).stage === 'failed', 20000);
  assert.equal(
    receiver.queue.jobs.get(job.id).error.code,
    'PATH_MAPPING_REQUIRED',
  );
  assert.equal(writes, 0);
  assert.equal((await receiver.listLocalSnapshots()).length, 1);
  await assert.rejects(receiver.confirmRestore({ jobId: job.id }), {
    code: 'PATH_MAPPING_REQUIRED',
  });
  await receiver.chooseRestoreMapping({ jobId: job.id, folder: 'path1' });
  await receiver.confirmRestore({ jobId: job.id });
  const restored = await harness.completed(receiver, job);
  assert.equal(restored.result.restored, true);
  assert.ok(restored.result.protectionSnapshotId);
  assert.equal(writes, 1);
});

test('partial restores retain safe per-path results and protection version without reporting complete success', async (t) => {
  const harness = await realHarness(t),
    fixture = manifestFixture();
  fixture.manifest.backup_paths.push({
    folder_name: 'path2',
    template: '{{p|localappdata}}/Test',
    type: 'folder',
  });
  const protectionSnapshotId = randomUUID(),
    protectionFolder = `2026-10-05T00-00-00-000Z_${protectionSnapshotId}`;
  let reportedError = 'PARTIAL_SECRET C:\\private\\save.dat';
  const service = await harness.newService('partial-restore', {
    restoreSnapshot: async () => ({
      error: reportedError,
      code: 'PARTIAL_RESTORE',
      protectionSnapshotId,
      protectionFolder,
      pathResults: [
        { folder: 'path1', success: true, sourcePath: 'PATH_SECRET' },
        {
          folder: 'path2',
          success: false,
          error: 'ERROR_SECRET https://example.invalid/signed?token=SECRET',
        },
        { folder: 'UNEXPECTED_SECRET', success: false, error: 'SECRET' },
      ],
    }),
  });
  const target = await harness.target(service, fixture.manifest.repositoryId);
  for (const error of [reportedError, null]) {
    reportedError = error;
    const job = await service.queue.add({
      id: randomUUID(),
      targetId: target.id,
      revision: target.revision,
      kind: 'restore',
      manifest: fixture.manifest,
      snapshotId: fixture.manifest.snapshotId,
      gameId: '42',
      gameKey: 'pcgw:42',
      result: {
        snapshotId: fixture.manifest.snapshotId,
        gameId: '42',
        folder: 'downloaded-version',
      },
      restoreConfirmed: true,
    });
    await until(() => service.queue.jobs.get(job.id).stage === 'failed');
    const finished = service.queue.jobs.get(job.id);
    assert.equal(finished.error.code, 'RESTORE_FAILED');
    assert.equal(finished.result.restored, false);
    assert.equal(finished.result.protectionSnapshotId, protectionSnapshotId);
    assert.equal(finished.result.protectionFolder, protectionFolder);
    assert.deepEqual(finished.result.pathResults, [
      { folder: 'path1', success: true },
      {
        folder: 'path2',
        success: false,
        error: {
          code: 'RESTORE_FAILED',
          message: '恢复未能全部完成，请检查本地恢复结果与保护备份。',
        },
      },
    ]);
    assert.ok(!JSON.stringify(service.publicJob(finished)).includes('SECRET'));
  }
});

test('successful restore exposes only safe custom-game registration status', async (t) => {
  const harness = await realHarness(t),
    fixture = manifestFixture();
  let registration;
  const service = await harness.newService('restore-registration', {
    restoreSnapshot: async () => ({
      error: null,
      customGameRegistration: registration,
    }),
  });
  const job = { manifest: fixture.manifest };
  const result = { gameId: '42', folder: 'downloaded-version' };
  const context = { update: async () => {} };
  for (const status of ['registered', 'existing']) {
    registration = { status, message: 'SECRET', path: 'SECRET' };
    assert.deepEqual(
      (await service.performRestore(job, result, context))
        .customGameRegistration,
      { status },
    );
  }
  for (const code of [
    'CUSTOM_ENTRIES_CORRUPT',
    'CUSTOM_GAME_INVALID',
    'CUSTOM_GAME_REGISTRATION_FAILED',
    'SECRET',
  ]) {
    registration = { status: 'failed', code, message: 'SECRET' };
    const restored = await service.performRestore(job, result, context);
    assert.equal(restored.restored, true);
    assert.deepEqual(restored.customGameRegistration, {
      status: 'failed',
      code: code === 'SECRET' ? 'CUSTOM_GAME_REGISTRATION_FAILED' : code,
    });
    assert.ok(!JSON.stringify(restored).includes('SECRET'));
  }
});

test('startup intent recovery closes the local-commit/queue-write window without duplicate tasks', async (t) => {
  const harness = await realHarness(t),
    service = await harness.newService('intent');
  service.queue.stopping = true;
  const target = await harness.target(service),
    jobId = randomUUID();
  const snapshot = await harness.snapshot(service, 0, {
    cloudUploadIntent: {
      targetId: target.id,
      revision: target.revision,
      repositoryId: target.repositoryId,
      deviceId: service.device.id,
      jobId,
      state: 'pending',
    },
  });
  await service.recoverIntents();
  await service.recoverIntents();
  assert.equal(service.queue.jobs.size, 1);
  assert.equal(service.queue.jobs.get(jobId).stage, 'pending');
  await service.controlJob({ jobId, action: 'cancel' });
  assert.equal(
    (
      await service.snapshots.readSnapshot(
        service.backupRoot(),
        '42',
        snapshot.folder,
      )
    ).metadata.cloudUploadIntent.state,
    'completed',
  );
});

test('restart repairs a committed remote version after both local source and archive have disappeared', async (t) => {
  const harness = await realHarness(t),
    original = await harness.newService('restart');
  const target = await harness.target(original),
    snapshot = await harness.snapshot(original);
  const uploaded = await harness.completed(
    original,
    await original.upload({
      targetId: target.id,
      gameId: '42',
      folder: snapshot.folder,
    }),
  );
  await original.finishJob(uploaded);
  await original.close();
  await fs.rm(snapshot.path, { recursive: true, force: true });
  await original.store.put('jobs', uploaded.id, {
    ...uploaded,
    stage: 'committing',
    result: null,
  });
  await original.store.delete(
    'versions',
    `${target.id}:${uploaded.result.versionId}`,
  );
  const restarted = await harness.newService('restart', {
    store: original.store,
  });
  const repaired = await harness.completed(restarted, uploaded);
  assert.equal(repaired.result.alreadyCommitted, true);
  assert.equal((await restarted.getState()).versions.length, 1);
});

test('queued old and new endpoint revisions send only their own credentials, while same-endpoint rotation is shared', async (t) => {
  const harness = await realHarness(t),
    received = [];
  const oldProvider = memoryProvider(),
    newProvider = memoryProvider();
  const service = await harness.newService('credentials', {
    createProvider: async (config, secrets) => {
      received.push({ url: config.url, ...secrets });
      return config.url === 'https://old.example' ? oldProvider : newProvider;
    },
  });
  service.queue.stopping = true;
  const config = {
    type: 'webdav',
    name: 'Storage',
    url: 'https://old.example',
    repositoryId: randomUUID(),
  };
  const first = await service.saveTarget({
    config,
    secrets: { username: 'old-user', password: 'old-password' },
  });
  const snapshot = await harness.snapshot(service);
  const oldJob = await service.upload({
    targetId: first.id,
    gameId: '42',
    folder: snapshot.folder,
  });
  const changed = await service.saveTarget({
    config: { ...config, id: first.id, url: 'https://new.example' },
    secrets: { username: 'new-user', password: 'new-password' },
  });
  const newJob = await service.upload({
    targetId: first.id,
    gameId: '42',
    folder: snapshot.folder,
  });
  service.queue.start();
  await harness.completed(service, oldJob);
  await harness.completed(service, newJob);
  assert.ok(
    received.some(
      (value) =>
        value.url === 'https://old.example' &&
        value.password === 'old-password',
    ),
  );
  assert.ok(
    received.some(
      (value) =>
        value.url === 'https://new.example' &&
        value.password === 'new-password',
    ),
  );
  assert.ok(
    received.every((value) =>
      value.url === 'https://old.example'
        ? value.username === 'old-user' && value.password === 'old-password'
        : value.username === 'new-user' && value.password === 'new-password',
    ),
  );
  await service.saveTarget({
    config: { ...changed },
    secrets: { password: 'rotated-password' },
  });
  await service.withRepository(
    await service.target(first.id, changed.revision),
    async () => {},
  );
  assert.equal(received.at(-1).password, 'rotated-password');
  await service.withRepository(
    await service.target(first.id, first.revision),
    async () => {},
  );
  assert.equal(received.at(-1).password, 'old-password');
  const another = await service.saveTarget({
    config: { ...changed, url: 'https://third.example' },
    secrets: {},
  });
  assert.equal(another.credentialsConfigured, false);
  assert.ok(!JSON.stringify(await service.getState()).includes('password'));
  assert.ok(
    !JSON.stringify(await service.store.list('revisions')).includes('password'),
  );
});

test('unreadable machine-bound credentials can be replaced by complete newly entered credentials', async (t) => {
  const harness = await realHarness(t);
  let unreadable = false;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 99)),
    decryptString: (value) => {
      if (unreadable) throw new Error('Different DPAPI user');
      return Buffer.from([...value].map((byte) => byte ^ 99)).toString();
    },
  };
  const service = await harness.newService('replace', { safeStorage });
  const target = await service.saveTarget({
    config: { type: 'webdav', name: 'Storage', url: 'https://storage.example' },
    secrets: { username: 'old', password: 'old-password' },
  });
  unreadable = true;
  await assert.rejects(
    service.saveTarget({
      config: target,
      secrets: { password: 'replacement' },
    }),
    { code: 'CREDENTIALS_UNAVAILABLE' },
  );
  const replaced = await service.saveTarget({
    config: target,
    secrets: { username: 'new', password: 'replacement' },
  });
  unreadable = false;
  const record = await service.target(replaced.id);
  assert.deepEqual(await service.credentials.get(record.credentialRef), {
    username: 'new',
    password: 'replacement',
  });
});
