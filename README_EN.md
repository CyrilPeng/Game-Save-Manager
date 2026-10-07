# Game Save Manager

[简体中文](./README.md) | English

A Windows game save manager with local versioned backups, WebDAV / S3 backups and recovery across devices. This project is maintained independently by CyrilPeng, with backup and recovery reliability as the priority.

## Features

- Discover installed games and known save locations, including Steam and Epic libraries.
- Add custom files, folders or registry saves, with path placeholders and account detection.
- Keep local snapshot history, pin versions, configure retention and automatic backups.
- Upload local snapshots to WebDAV or S3-compatible storage. Local backup results and cloud task results are tracked separately.
- Persist cloud tasks, pause and retry transfers, diagnose permissions and preview older backups before uploading.
- Browse backups from other devices, verify downloads before recovery, and import / export .gsmr archives.

## Download and setup

Download the Windows x64 installer from [Releases](https://github.com/CyrilPeng/Game-Save-Manager/releases). Test builds are marked Pre-release. Source changes reach downloadable installers only after a new build is published.

1. Choose a local backup directory, preferably on a different disk from your saves.
2. Scan for games or add a custom save location.
3. Complete a local backup, then configure WebDAV or S3 in Cloud Storage.
4. Review authentication, listing, writing, read-back and cleanup results, then perform an actual upload.
5. Download a cloud version and verify recovery into a temporary directory before enabling automatic backups.

Cloud backups are versioned copies, not live two-way synchronization. A connection test does not replace an upload, download and recovery check. Local regression tests cover 123 Cloud download redirects; a real account still requires manual validation.

## Configuration and updates

The application name, existing user-data location and backup format remain compatible. Settings and cloud tasks live in Electron's userData directory, usually %APPDATA%/Game Save Manager on Windows; existing installations may retain a historical directory. Saves live in your configured backup directory. Credentials use the operating system's encryption API and must be configured again on another device.

A game-location database is bundled with the application. Updates download database.db and database-manifest.json from this repository's Releases and check SHA-256, SQLite integrity and required columns before replacement. Failed updates preserve the existing database. Application updates open this repository's Releases; the original author's update service is no longer used.

## Development

Requires Windows x64, Node.js 24, npm and Git. The repository includes the database; no separate Automation checkout or private configuration is required.


```bash
git clone https://github.com/CyrilPeng/Game-Save-Manager.git
cd Game-Save-Manager
npm ci
npm start
```

| Command | Purpose |
| --- | --- |
| npm test | Core file, snapshot, restore, cloud task and permission regression tests |
| npm run test:electron | Isolated integration with real Electron, SQLite, 7-Zip and WebDAV |
| npm run build | Compile the application |
| npm run package | Create an unpacked application directory |

## Contributions

Use [Issues](https://github.com/CyrilPeng/Game-Save-Manager/issues) for reports. Include the application version, Windows version, reproduction steps and sanitized logs. For cloud issues, include the provider and individual diagnostic results. Never share passwords, tokens or actual saves.

Changes to backups, recovery, archives or cloud queues should pass both the core and Electron integration tests. Use conventional commits. Release notes are maintained in GitHub Releases.

## License and origin

Licensed under [GPL-3.0-only](./LICENSE.txt), retaining the original copyright notice. Game-location data comes from PCGamingWiki.

Originally forked from [dyang886/Game-Save-Manager](https://github.com/dyang886/Game-Save-Manager), now independently maintained. Thanks to Yongcan Yang and the original contributors.
