const { getSettings } = require('../settings/store');
function getGameDisplayName(gameObj) {
  if (getSettings().language === 'zh_CN') {
    return gameObj.zh_CN || gameObj.title;
  }
  return gameObj.title;
}

module.exports = { getGameDisplayName };
