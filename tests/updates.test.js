const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const sqlite3 = require('sqlite3');
const project = require('../src/project');
const {
  selectRelease,
  createReleaseClient,
} = require('../src/main/updates/releases');
const {
  installDatabase,
  updateDatabaseFromRelease,
} = require('../src/main/updates/database');

const release = (version, extra = {}) => ({
  tag_name: 'v' + version,
  html_url: project.releasesUrl + '/tag/v' + version,
  ...extra,
});
test('release selection uses semantic versions and isolates stable and preview channels', () => {
  const releases = [
    release('2.9.0'),
    release('2.10.0'),
    release('3.0.0-beta.2', { prerelease: true }),
    release('9.0.0', { draft: true }),
    release('8.0.0', { html_url: 'https://example.com/tag/8' }),
  ];
  assert.equal(selectRelease(releases, '2.2.2').version, '2.10.0');
  assert.equal(selectRelease(releases, '2.2.2-beta.1').version, '3.0.0-beta.2');
  assert.equal(selectRelease([], '2.2.2'), null);
});
test('release API rejects malformed responses and exposes network failures', async () => {
  await assert.rejects(
    createReleaseClient({
      currentVersion: '2.2.2',
      request: async () => ({ data: {} }),
    }).latest(),
    /Invalid release/,
  );
  await assert.rejects(
    createReleaseClient({
      currentVersion: '2.2.2',
      request: async () => {
        throw new Error('offline');
      },
    }).latest(),
    /offline/,
  );
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-update-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.db');
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(source, (error) =>
      error ? reject(error) : resolve(connection),
    );
  });
  await new Promise((resolve, reject) =>
    db.exec(
      'CREATE TABLE games (wiki_page_id TEXT, title TEXT, save_location TEXT, platform TEXT, install_folder TEXT, steam_id TEXT, gog_id TEXT, zh_CN TEXT)',
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  await new Promise((resolve, reject) =>
    db.close((error) => (error ? reject(error) : resolve())),
  );
  const bytes = await fs.readFile(source);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const destination = path.join(directory, 'installed.db');
  await fs.writeFile(destination, 'existing database');
  return { directory, source, bytes, hash, destination };
}
test('database installation validates before replacing the existing file', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    installDatabase(f.source, f.destination, '0'.repeat(64)),
    /checksum mismatch/,
  );
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'existing database');
  await fs.writeFile(f.source, Buffer.alloc(1024, 1));
  await assert.rejects(installDatabase(f.source, f.destination));
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'existing database');
  await fs.writeFile(f.source, f.bytes);
  await installDatabase(f.source, f.destination, f.hash);
  assert.deepEqual(await fs.readFile(f.destination), f.bytes);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), [
    'installed.db',
    'source.db',
  ]);
});
test('database download checks release assets and detects tampering or interrupted streams', async (t) => {
  const f = await fixture(t);
  const assets = ['database.db', 'database-manifest.json'].map((name) => ({
    name,
    size: f.bytes.length,
    browser_download_url: project.releasesUrl + '/download/v2.2.2/' + name,
  }));
  const latest = release('2.2.2', { assets });
  const request = async (url) => ({
    data: url.endsWith('.json') ? { sha256: f.hash } : Readable.from([f.bytes]),
  });
  await assert.rejects(
    updateDatabaseFromRelease({
      release: release('2.2.2'),
      destination: f.destination,
      request,
    }),
    /no database/,
  );
  await assert.rejects(
    updateDatabaseFromRelease({
      release: latest,
      destination: f.destination,
      request: async (url) => ({
        data: url.endsWith('.json')
          ? { sha256: '0'.repeat(64) }
          : Readable.from([f.bytes]),
      }),
    }),
    /checksum mismatch/,
  );
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'existing database');
  const broken = async (url) => ({
    data: url.endsWith('.json')
      ? { sha256: f.hash }
      : Readable.from(
          (async function* () {
            yield f.bytes.subarray(0, 128);
            throw new Error('disconnected');
          })(),
        ),
  });
  await assert.rejects(
    updateDatabaseFromRelease({
      release: latest,
      destination: f.destination,
      request: broken,
    }),
    /disconnected/,
  );
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'existing database');
  await updateDatabaseFromRelease({
    release: latest,
    destination: f.destination,
    request,
  });
  assert.deepEqual(await fs.readFile(f.destination), f.bytes);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), [
    'installed.db',
    'source.db',
  ]);
});
