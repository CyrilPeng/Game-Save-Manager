// Compatibility exports for existing backup adapters. New modules import their owners directly.
module.exports = {
  ...require('./app/windows'),
  ...require('./app/state'),
  ...require('./updates/app'),
  ...require('./games/display'),
  ...require('./platform/files'),
  ...require('./backup/history'),
  ...require('./backup/transfers'),
  ...require('./platform/saves'),
  ...require('./platform/paths'),
  ...require('./settings/store'),
  ...require('./backup/migrationController'),
};
