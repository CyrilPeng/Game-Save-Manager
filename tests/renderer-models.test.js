const test = require('node:test');
const assert = require('node:assert/strict');
const { orderEntries } = require('../src/renderer/shared/sorting');
const {
  createTableUpdateQueue,
} = require('../src/renderer/shared/tableUpdateQueue');
const {
  filterVersions,
  jobActions,
  byteSize,
} = require('../src/renderer/features/cloud/presentation');

test('sorting keeps missing dates last and equal values alphabetical in either direction', () => {
  const entries = [
    {
      title: 'Beta',
      game: { latest_backup: '2026/10/07 10:00', backup_size: 20 },
    },
    { title: 'Unknown', game: {} },
    {
      title: 'Alpha',
      game: { latest_backup: '2026/10/07 10:00', backup_size: 20 },
    },
    {
      title: 'Earlier',
      game: { latest_backup: '2026/10/06 10:00', backup_size: 10 },
    },
  ];
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  assert.deepEqual(
    orderEntries(entries, { key: 'time', direction: 'desc' }, byTitle).map(
      (e) => e.title,
    ),
    ['Alpha', 'Beta', 'Earlier', 'Unknown'],
  );
  assert.deepEqual(
    orderEntries(entries, { key: 'time', direction: 'asc' }, byTitle).map(
      (e) => e.title,
    ),
    ['Earlier', 'Alpha', 'Beta', 'Unknown'],
  );
  assert.equal(entries[0].title, 'Beta');
});

test('cloud versions filter by repository and device, then show newest first', () => {
  const versions = [
    {
      versionId: 'old',
      targetId: 'a',
      manifest: {
        gameTitle: 'My Game',
        originDeviceId: 'pc',
        createdAt: '2026-10-05T00:00:00Z',
      },
    },
    {
      versionId: 'other',
      targetId: 'b',
      manifest: { gameTitle: 'My Game', originDeviceId: 'pc' },
    },
    {
      versionId: 'new',
      targetId: 'a',
      manifest: {
        gameTitle: 'My Game',
        publisherDeviceId: 'pc',
        createdAt: '2026-10-07T00:00:00Z',
      },
    },
    {
      versionId: 'laptop',
      targetId: 'a',
      manifest: { gameTitle: 'My Game', originDeviceId: 'laptop' },
    },
  ];
  assert.deepEqual(
    filterVersions(versions, {
      targetId: 'a',
      deviceId: 'pc',
      search: ' GAME ',
    }).map((v) => v.versionId),
    ['new', 'old'],
  );
  assert.deepEqual(jobActions('paused'), ['resume', 'cancel']);
  assert.deepEqual(jobActions('failed'), ['retry', 'cancel']);
  assert.deepEqual(jobActions('completed'), []);
  assert.equal(byteSize(65536), '64 KiB');
});

function setupQueue() {
  const calls = [];
  const queue = createTableUpdateQueue({
    setBusy: (tab, busy) => calls.push([tab, 'busy', busy]),
    showLoading: (tab) => calls.push([tab, 'show']),
    hideLoading: (tab) => calls.push([tab, 'hide']),
    updateRow: (tab, id) => calls.push([tab, 'update', id]),
    removeRow: (tab, id) => calls.push([tab, 'remove', id]),
    onError: (tab, error) => calls.push([tab, 'error', error.message]),
  });
  return { calls, queue };
}

test('reloads coalesce, row actions stay ordered, and tables run independently', async () => {
  const { calls, queue } = setupQueue();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = queue.reload('backup', true, async () => {
    calls.push(['first']);
    await gate;
  });
  await Promise.resolve();
  queue.reload('backup', false, () => calls.push(['discarded']));
  queue.reload('backup', false, () => calls.push(['latest']));
  queue.update('backup', 'game');
  queue.remove('backup', 'game');
  await queue.update('restore', 'other');
  assert.ok(calls.some((c) => c[0] === 'restore' && c[1] === 'update'));
  release();
  await running;
  assert.ok(!calls.some((c) => c[0] === 'discarded'));
  assert.ok(!calls.some((c) => c[1] === 'update' && c[2] === 'game'));
  assert.ok(
    calls.findIndex((c) => c[0] === 'latest') <
      calls.findIndex((c) => c[1] === 'remove'),
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === 'backup'),
    [
      ['backup', 'busy', true],
      ['backup', 'show'],
      ['backup', 'remove', 'game'],
      ['backup', 'hide'],
      ['backup', 'busy', false],
    ],
  );
});

test('a failed table reload releases the loader and accepts the next request', async () => {
  const { calls, queue } = setupQueue();
  await queue.reload('backup', true, () => {
    throw new Error('failed load');
  });
  await queue.update('backup', 'retry');
  assert.deepEqual(calls, [
    ['backup', 'busy', true],
    ['backup', 'show'],
    ['backup', 'error', 'failed load'],
    ['backup', 'hide'],
    ['backup', 'busy', false],
    ['backup', 'busy', true],
    ['backup', 'update', 'retry'],
    ['backup', 'busy', false],
  ]);
});
