# Game Save Manager

简体中文 | [English](./README_EN.md)

Windows 游戏存档管理器，提供本地版本备份、WebDAV / S3 云端备份和跨设备恢复。本项目由 CyrilPeng 独立维护，优先保障存档备份与恢复的可靠性。

## 功能

- 自动发现已安装游戏及已知存档位置，支持 Steam、Epic 等游戏平台。
- 手动添加文件、文件夹和注册表存档，支持路径占位符与多账号识别。
- 本地快照保留版本历史，支持固定版本、保留数量和自动备份。
- 将本地快照上传到 WebDAV 或 S3 兼容存储；本地备份和云端任务分别记录结果。
- 云任务持久化，支持暂停、重试、连接诊断及旧备份预览补传。
- 浏览其他设备的云端版本，下载、校验后恢复；支持导入、导出 .gsmr 归档。

## 下载与使用

在 [Releases](https://github.com/CyrilPeng/Game-Save-Manager/releases) 下载 Windows x64 安装包。测试版本会标记为 Pre-release；当前仓库中的改动只有发布新安装包后才会进入下载版本。

1. 选择本地备份目录，建议放在与原存档不同的磁盘。
2. 扫描游戏，或在“自定义游戏”中添加存档位置。
3. 先完成一次本地备份，再到“云存储”配置 WebDAV 或 S3。
4. 检查连接诊断中的认证、列举、写入、读回校验和清理结果，然后执行一次实际上传。
5. 选择一个云端版本，下载并在临时目录验证恢复结果，确认能用后再建立自动备份策略。

云端备份是版本副本，不是实时双向同步。连接测试通过也不能替代完整的上传、下载和恢复验证。123 云盘的下载重定向已有本地回归用例；真实账号仍需实机验证。

## 配置与数据

现有应用名称、用户数据位置及本地备份格式保持兼容。配置与云任务保存在 Electron 的 userData 目录；Windows 通常为 %APPDATA%/Game Save Manager，已有安装可能沿用历史目录。备份内容保存在设置的备份目录。云端凭据通过系统凭据加密接口保存，跨设备使用时需重新配置。

游戏位置数据库随应用提供。数据库更新从本仓库 Release 下载 database.db 和 database-manifest.json，验证 SHA-256、SQLite 完整性和必要字段后替换；更新失败会保留旧数据库。应用升级通过本仓库 Releases 下载，软件不再访问原作者的更新服务。

## 开发

需要 Windows x64、Node.js 24、npm 和 Git。数据库已包含在仓库，不需要外部 Automation 项目或私有配置。

```bash
git clone https://github.com/CyrilPeng/Game-Save-Manager.git
cd Game-Save-Manager
npm ci
npm start
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| npm test | 文件、快照、恢复、云任务和权限回归 |
| npm run test:electron | 真实 Electron、SQLite、7-Zip、WebDAV 的隔离集成测试 |
| npm run build | 编译应用 |
| npm run package | 生成未安装的应用目录 |
| npm run test:app / test:packaged | 验证生产入口、页面、备份恢复及 ASAR 原生依赖 |
| npm run lint / format:check | 检查错误与代码格式 |
| npm run verify:resources | 校验随应用提供的数据库 |
| npm run dist | 生成 Windows x64 安装包，不自动发布 |

目录职责、测试边界及发行步骤见 [开发与维护](./CONTRIBUTING.md)。

## 反馈与贡献

请在 [Issues](https://github.com/CyrilPeng/Game-Save-Manager/issues) 提供软件版本、Windows 版本、操作步骤和脱敏日志。云存储问题请同时提供服务类型和各项连接诊断结果，不要提交密码、令牌或真实存档。

修改备份、恢复、归档或云队列时，应运行核心测试及 Electron 集成测试。提交说明使用约定式提交；版本说明集中在 GitHub Releases。

## 许可证与来源

本项目采用 [GPL-3.0-only](./LICENSE.txt)，保留原作者版权声明。游戏位置数据来自 PCGamingWiki。

本项目最初 fork 自 [dyang886/Game-Save-Manager](https://github.com/dyang886/Game-Save-Manager)，现独立维护。感谢原作者 Yongcan Yang 及贡献者。
