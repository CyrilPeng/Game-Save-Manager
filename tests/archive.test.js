const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const archive = require('../src/main/backup/archive');
const snapshots = require('../src/main/backup/snapshotStore');

test('archive listing rejects traversal, links, duplicate names and expanded limits', () => {
    const record = (name, extra = '') => `Path = ${name}\nSize = 5\nAttributes = A\n${extra}`;
    for (const name of ['../escape', 'C:/evil', '/absolute', 'dir/CON.txt', 'dir/a:stream', 'dir/a.']) assert.throws(() => archive.parseListing(record(name)));
    assert.throws(() => archive.parseListing(record('file', 'Symbolic Link = ../x')));
    assert.throws(() => archive.parseListing(record('file') + '\n\n' + record('FILE')));
    assert.throws(() => archive.parseListing(record('file'), { maxBytes: 4 }));
    assert.throws(() => archive.parseListing(record('dir') + '\n\n' + record('dir/file')));
});

test('single-snapshot archive roundtrip checks frozen metadata and integrity', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-archive-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
    const source = path.join(root,'source'); await fs.mkdir(path.join(source,'path1'),{recursive:true});
    await fs.writeFile(path.join(source,'path1','游戏存档 [1].sav'),'payload');
    const metadata = {schemaVersion:1,snapshotId:randomUUID(),createdAt:new Date().toISOString(),gameKey:'pcgw:123',title:'Game',backup_paths:[{folder_name:'path1',type:'folder',template:'{{p|appdata}}\\Game'}]};
    await fs.writeFile(path.join(source,'backup_info.json'),JSON.stringify(metadata));
    const output=path.join(root,'test.gsmr'); const before=process.cwd();
    const result=await archive.createSnapshotArchive({path:source,metadata},output,{metadata:{...metadata,custom_name:'frozen'}});
    assert.equal(process.cwd(),before); assert.equal(result.fileCount,2);
    const manifest={...result,snapshotMetadata:result.metadata,backup_paths:metadata.backup_paths};
    const restored=await archive.extractSnapshotArchive(output,path.join(root,'restored'),manifest);
    assert.equal(restored.metadata.custom_name,'frozen');
    assert.equal(await fs.readFile(path.join(restored.path,'path1','游戏存档 [1].sav'),'utf8'),'payload');
    const corrupt=path.join(root,'corrupt.gsmr'); const buffer=await fs.readFile(output); buffer[10]^=1; await fs.writeFile(corrupt,buffer);
    await assert.rejects(archive.extractSnapshotArchive(corrupt,path.join(root,'bad'),manifest),/integrity/);
    await assert.rejects(fs.stat(path.join(root,'bad')), {code:'ENOENT'});
    await assert.rejects(archive.extractSnapshotArchive(output,path.join(root,'mismatch'),{...manifest,snapshotMetadata:{...manifest.snapshotMetadata,title:'wrong'}}),/metadata differ/);
});

test('legacy multi-game archive extraction keeps game/version structure', async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'gsm-legacy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const relative='123/2024-01-02_03-04';const source=path.join(root,'source');await fs.mkdir(path.join(source,relative,'path1'),{recursive:true});
    const metadata={title:'Old game',backup_paths:[{folder_name:'path1',type:'file',template:'C:\\Saves\\a.sav'}]};
    await fs.writeFile(path.join(source,relative,'backup_info.json'),JSON.stringify(metadata));await fs.writeFile(path.join(source,relative,'path1','a.sav'),'old');
    await archive.createArchive(source,[relative],path.join(root,'old.gsmr'));
    await archive.extractArchive(path.join(root,'old.gsmr'),path.join(root,'dest'));
    const snapshot=await snapshots.readSnapshot(path.join(root,'dest'),'123','2024-01-02_03-04');assert.equal(snapshot.metadata.timezoneUncertain,true);
});
