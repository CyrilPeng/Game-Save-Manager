const { contextBridge, ipcRenderer } = require('electron');

const {
  LEGACY_CHANNELS,
  CLOUD_METHODS: cloudMethods,
} = require('../shared/ipc');
const channels = Object.fromEntries(
  Object.entries(LEGACY_CHANNELS).map(([kind, values]) => [
    kind,
    new Set(values),
  ]),
);
function validateChannel(kind, channel) {
  if (!channels[kind].has(channel)) throw new Error('Unsupported IPC channel');
}
function subscribe(channel, listener) {
  if (typeof listener !== 'function')
    throw new TypeError('Listener must be a function');
  const wrapped = (_event, ...args) => listener(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}
const cloud = Object.fromEntries(
  cloudMethods.map((method) => [
    method,
    (payload = {}) => ipcRenderer.invoke(`cloud:${method}`, payload),
  ]),
);
cloud.onState = (listener) => subscribe('cloud:state', listener);

contextBridge.exposeInMainWorld('api', {
  send: (channel, ...args) => {
    validateChannel('send', channel);
    ipcRenderer.send(channel, ...args);
  },
  receive: (channel, func) => {
    validateChannel('receive', channel);
    return subscribe(channel, func);
  },
  invoke: (channel, ...args) => {
    validateChannel('invoke', channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  cloud: Object.freeze(cloud),
});

contextBridge.exposeInMainWorld('i18n', {
  translate: (key, options) => ipcRenderer.invoke('translate', key, options),
});
