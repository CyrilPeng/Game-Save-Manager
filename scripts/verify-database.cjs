const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { validateDatabase } = require('../src/main/updates/database');
async function main() {
  const root = path.resolve(__dirname, '../resources/database');
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'database-manifest.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(
    (await fs.stat(path.join(root, 'database.db'))).size,
    manifest.bytes,
  );
  await validateDatabase(path.join(root, 'database.db'), manifest.sha256);
  console.log(
    JSON.stringify({
      ok: true,
      databaseBytes: manifest.bytes,
      sha256: manifest.sha256,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
