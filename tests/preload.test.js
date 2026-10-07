const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { CLOUD_METHODS } = require('../src/shared/ipc');
function loadPreload() {
  const exposed = {};
  const calls = [];
  const listeners = new Map();
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, value) => {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      send: (...args) => calls.push(args),
      invoke: (...args) => {
        calls.push(args);
        return Promise.resolve('ok');
      },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/preload/preload.js'), 'utf8'),
    {
      require: (name) =>
        name === 'electron' ? electron : require('../src/shared/ipc'),
    },
  );
  return { ...exposed, calls, listeners };
}
test('preload rejects unlisted IPC channels and does not leak Electron events', () => {
  const { api, calls, listeners } = loadPreload();
  assert.throws(() => api.send('arbitrary'), /Unsupported IPC/);
  assert.throws(() => api.invoke('cloud:restore'), /Unsupported IPC/);
  assert.throws(() => api.receive('arbitrary', () => {}), /Unsupported IPC/);
  assert.equal(calls.length, 0);
  let received;
  const unsubscribe = api.receive('show-alert', (...args) => {
    received = args;
  });
  listeners.get('show-alert')(
    { sender: 'private Electron event' },
    'success',
    'done',
  );
  assert.deepEqual(received, ['success', 'done']);
  unsubscribe();
  assert.equal(listeners.has('show-alert'), false);
});
test('cloud methods use the shared contract and state listeners can unsubscribe', async () => {
  const { api, i18n, calls, listeners } = loadPreload();
  const payload = { targetId: 'target' };
  for (const method of CLOUD_METHODS) {
    assert.equal(await api.cloud[method](payload), 'ok');
    assert.deepEqual(calls.at(-1), [`cloud:${method}`, payload]);
  }
  const stop = api.cloud.onState(() => {});
  stop();
  assert.equal(listeners.size, 0);
  await i18n.translate('hello', { count: 1 });
  assert.deepEqual(calls.at(-1), ['translate', 'hello', { count: 1 }]);
});
