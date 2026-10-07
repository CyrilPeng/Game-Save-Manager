const { BrowserWindow, Menu, app } = require('electron');
const path = require('path');
const i18next = require('i18next');
let win, settingsWin, aboutWin;
const initializeMenu = () => {
  return [
    {
      label: i18next.t('main.options'),
      submenu: [
        {
          label: i18next.t('settings.title'),
          click() {
            let settings_window_size = [650, 700];
            // Check if settingsWin is already open
            if (!settingsWin || settingsWin.isDestroyed()) {
              settingsWin = new BrowserWindow({
                show: process.env.NODE_ENV !== 'test',
                width: settings_window_size[0],
                height: settings_window_size[1],
                minWidth: settings_window_size[0],
                minHeight: settings_window_size[1],
                icon: path.join(__dirname, '../assets/setting.ico'),
                parent: win,
                modal: true,
                webPreferences: {
                  preload: path.join(__dirname, '../preload/preload.js'),
                  sandbox: false,
                },
              });

              if (!app.isPackaged && process.env.NODE_ENV !== 'test') {
                settingsWin.webContents.openDevTools({ mode: 'detach' });
              }
              settingsWin.setMenuBarVisibility(false);
              settingsWin.loadFile(
                path.join(__dirname, '../renderer/settings.html'),
              );

              settingsWin.on('closed', () => {
                settingsWin = null;
              });
            } else {
              settingsWin.focus();
            }
          },
        },
        {
          label: i18next.t('main.view_account_ids'),
          click() {
            win.webContents.send('view_account_ids');
          },
        },
        {
          label: i18next.t('main.scan_full'),
          click() {
            win.webContents.send('scan-full');
          },
        },
        {
          label: i18next.t('main.manage_hidden_games'),
          click() {
            win.webContents.send('open-hidden-games-modal');
          },
        },
        {
          label: i18next.t('about.title'),
          click() {
            let about_window_size = [480, 290];
            if (!aboutWin || aboutWin.isDestroyed()) {
              aboutWin = new BrowserWindow({
                show: process.env.NODE_ENV !== 'test',
                width: about_window_size[0],
                height: about_window_size[1],
                resizable: false,
                icon: path.join(__dirname, '../assets/logo.ico'),
                parent: win,
                modal: true,
                webPreferences: {
                  preload: path.join(__dirname, '../preload/preload.js'),
                  sandbox: false,
                },
              });

              if (!app.isPackaged && process.env.NODE_ENV !== 'test') {
                aboutWin.webContents.openDevTools({ mode: 'detach' });
              }
              aboutWin.setMenuBarVisibility(false);
              aboutWin.loadFile(path.join(__dirname, '../renderer/about.html'));

              aboutWin.on('closed', () => {
                aboutWin = null;
              });
            } else {
              aboutWin.focus();
            }
          },
        },
      ],
    },
    {
      label: i18next.t('main.export'),
      click() {
        win.webContents.send('open-export-modal');
      },
    },
    {
      label: i18next.t('main.import'),
      click() {
        win.webContents.send('open-import-modal', '');
      },
    },
  ];
};

// Main window
const createMainWindow = async () => {
  let main_window_size = [1150, 750];
  win = new BrowserWindow({
    show: process.env.NODE_ENV !== 'test',
    width: main_window_size[0],
    height: main_window_size[1],
    minWidth: main_window_size[0],
    minHeight: main_window_size[1],
    icon: path.join(__dirname, '../assets/logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      sandbox: false,
    },
  });

  if (!app.isPackaged && process.env.NODE_ENV !== 'test') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  const menu = Menu.buildFromTemplate(initializeMenu());
  Menu.setApplicationMenu(menu);

  win.on('closed', () => {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (window !== win) {
        window.close();
      }
    });

    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
};

module.exports = {
  initializeMenu,
  createMainWindow,
  getMainWin: () => win,
  getAboutWin: () => aboutWin,
};
