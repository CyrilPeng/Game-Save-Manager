const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSettingsUpdates, publicSettings } = require('../src/main/settingsValidation');
test('ordinary settings cannot accept or return cloud secrets including nested values', () => {
    assert.equal(validateSettingsUpdates({password:'secret'}),false);
    assert.equal(validateSettingsUpdates({cloud:{secretAccessKey:'secret'}}),false);
    assert.equal(validateSettingsUpdates({theme:{password:'secret'}}),false);
    assert.equal(validateSettingsUpdates({autoBackupGames:{'123':{mode:'interval',intervalMinutes:5,password:'secret'}}}),false);
    assert.deepEqual(publicSettings({theme:'dark',password:'secret',cloudCredentials:'secret',pinnedGames:{password:'secret'}}),{theme:'dark'});
});
test('existing local backup watcher and interval settings retain their shape', () => {
    const settings={autoBackupGames:{'123':{mode:'watcher',intervalMinutes:null},'456':{mode:'interval',intervalMinutes:5}},pinnedGames:['123'],theme:'dark'};
    assert.equal(validateSettingsUpdates(settings),true);
    assert.deepEqual(publicSettings(settings),settings);
});
