const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');
const { getSettings } = require('../settings/store');
const placeholder_mapping = {
  // Windows
  '{{p|username}}': os.userInfo().username,
  '{{p|userprofile}}': process.env.USERPROFILE || os.homedir(),
  '{{p|userprofile/documents}}': path.join(
    process.env.USERPROFILE || os.homedir(),
    'Documents',
  ),
  '{{p|userprofile/appdata/locallow}}': path.join(
    process.env.USERPROFILE || os.homedir(),
    'AppData',
    'LocalLow',
  ),
  '{{p|appdata}}':
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'),
  '{{p|localappdata}}':
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
  '{{p|programfiles}}': process.env.PROGRAMFILES || 'C:\\Program Files',
  '{{p|programdata}}': process.env.PROGRAMDATA || 'C:\\ProgramData',
  '{{p|public}}': path.join(process.env.PUBLIC || 'C:\\Users\\Public'),
  '{{p|windir}}': process.env.WINDIR || 'C:\\Windows',

  // Registry
  '{{p|hkcu}}': 'HKEY_CURRENT_USER',
  '{{p|hklm}}': 'HKEY_LOCAL_MACHINE',
  '{{p|wow64}}': 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node',

  // Mac
  '{{p|osxhome}}': os.homedir(),

  // Linux
  '{{p|linuxhome}}': os.homedir(),
  '{{p|xdgdatahome}}':
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  '{{p|xdgconfighome}}':
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
};

const osKeyMap = {
  win32: 'win',
  darwin: 'mac',
  linux: 'linux',
};

// The install root holding this folder, or null; existsSync matches case like Windows
function findGameInstallPath(installFolder) {
  if (!installFolder) return null;

  for (const installPath of getSettings().gameInstalls) {
    const potentialPath = path.join(installPath, installFolder);
    if (fsOriginal.existsSync(potentialPath)) return potentialPath;
  }
  return null;
}

module.exports = { placeholder_mapping, osKeyMap, findGameInstallPath };
