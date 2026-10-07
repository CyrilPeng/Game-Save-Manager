const { Notification, app, ipcMain, shell } = require('electron');
const path = require('path');
const i18next = require('i18next');
const semver = require('semver');
const project = require('../../project');
const { createReleaseClient } = require('./releases');
const { getAboutWin } = require('../app/windows');
const appVersion = app.getVersion();
const releaseClient = createReleaseClient({ currentVersion: appVersion });
let updatingApp = false;
function resource_path(resource_name) {
  if (!app.isPackaged) {
    return path.join(__dirname, '../assets_export', resource_name);
  } else {
    return path.join(process.resourcesPath, 'assets_export', resource_name);
  }
}

async function getLatestVersion() {
  try {
    return (await releaseClient.latest())?.version || null;
  } catch (error) {
    console.error('Unable to check project releases:', error.message);
    return null;
  }
}

async function checkAppUpdate() {
  try {
    const latestVersion = await getLatestVersion('GSM');
    const currentVersion = semver.valid(appVersion);

    if (!currentVersion) {
      console.error(`Error: Invalid current app version '${appVersion}'.`);
      return;
    }

    if (latestVersion && semver.gt(latestVersion, currentVersion)) {
      showNotification(
        'app',
        i18next.t('alert.update_available'),
        `${i18next.t('alert.new_version_found', { old_version: appVersion, new_version: latestVersion })}\n` +
          `${i18next.t('alert.new_version_found_text')}`,
        latestVersion,
      );
    }
  } catch (error) {
    console.error('Error checking for update:', error.stack);
    showNotification(
      'app',
      i18next.t('alert.update_check_failed'),
      i18next.t('alert.update_check_failed_text'),
    );
  }
}

function showNotification(type, title, body, latest_version = 0) {
  const icon_map = {
    app: resource_path('logo.png'),
    info: resource_path('information.png'),
    warning: resource_path('warning.png'),
    critical: resource_path('critical.png'),
  };

  if (process.platform === 'win32') {
    const toastXml = `
            <toast launch="gamesavemanager://default-click">
                <visual>
                    <binding template="ToastImageAndText04">
                        <image id="1" src="${icon_map[type]}" placement="appLogoOverride"/>
                        <text id="1">${title}</text>
                        <text id="2">${body}</text>
                    </binding>
                </visual>
                <actions>
                    <action content="${i18next.t('alert.yes')}" activationType="protocol" arguments="gamesavemanager://yes"/>
                    <action content="${i18next.t('alert.no')}" activationType="protocol" arguments="gamesavemanager://no"/>
                </actions>
            </toast>
        `;

    app.setAppUserModelId(project.appId);
    const notification = new Notification({
      toastXml: toastXml,
    });
    notification.show();

    const handleAction = (event, action) => {
      if (action === 'yes') {
        updateApp(latest_version);
      }
      ipcMain.removeListener('notification-action', handleAction);
    };
    ipcMain.on('notification-action', handleAction);
  } else {
    const notification = new Notification({
      title: title,
      body: body,
      icon: icon_map[type],
    });
    notification.show();
  }
}

async function updateApp() {
  if (updatingApp) return;
  updatingApp = true;
  try {
    await shell.openExternal(project.releasesUrl);
  } catch (error) {
    console.error('Unable to open project releases:', error.message);
  } finally {
    updatingApp = false;
    if (getAboutWin() && !getAboutWin().isDestroyed())
      getAboutWin().webContents.send('app-update-ended');
  }
}

module.exports = {
  getCurrentVersion: () => appVersion,
  getLatestVersion,
  checkAppUpdate,
  updateApp,
};
