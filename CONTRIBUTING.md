# 开发与维护

需要 Windows x64、Node.js 24 和 npm。使用 npm ci 按 package-lock.json 安装依赖；运行 npm start 开发，npm run build 编译生产应用。

## 代码位置

| 目录 | 职责 |
| --- | --- |
| src/main/app | 应用启动、窗口、菜单与状态 |
| src/main/backup | 本地快照、恢复保护、归档、迁移与自动备份 |
| src/main/cloud | 云仓库、持久化任务、凭据与 WebDAV / S3 提供方 |
| src/main/games | 游戏目录、自定义条目、账号及存档路径解析 |
| src/main/settings | 配置校验与串行写入事务 |
| src/main/platform | 文件系统、注册表与平台路径 |
| src/main/updates | 本仓库应用版本与数据库更新 |
| src/main/ipc | 按业务注册通信入口 |
| src/preload、src/shared | 页面可用接口及共享通信契约 |
| src/renderer/pages | 四个窗口的入口、模板及页面初始化 |
| src/renderer/features | 按功能组织的页面交互 |
| src/renderer/shared | 表格、排序、刷新队列、弹窗、翻译与进度 |
| resources/database | 随应用提供的数据库及校验清单 |

主入口只负责启动。IPC 入口负责请求检查及服务调用；文件写入、快照和恢复逻辑归各自服务。src/main/global.js 和少量前端公共出口用于兼容现有调用，新增业务应直接导入所属模块。

## 修改与验证

- 执行 npm run lint、npm run format:check 和 npm test；需要格式化时运行 npm run format。
- 修改快照、恢复、归档、队列或 IPC 时，执行 npm run test:electron。它会编译 preload，并使用临时目录、隐藏窗口及本机 WebDAV 服务验证两个设备之间的上传、下载和恢复。
- 修改主入口、页面、资源或打包配置时，执行 npm run verify:resources、npm run build 和 npm run test:app。后者从真实主入口启动，验证页面、配置保存、本地备份、恢复前保护副本及恢复结果。
- 运行 npm run package 后执行 npm run test:packaged，检查 ASAR 内的代码及原生依赖。它通过开发环境中的同版本 Electron 加载打包代码和资源路径；安装程序及真实云账号仍需手工测试。

集成测试使用临时配置和备份，不使用日常备份库，不注册文件协议。注册表回归只操作临时 HKCU 测试键。不要把真实存档、账号、密码或令牌加入夹具。

测试应覆盖实际失败后果，例如写入中断保留旧文件、损坏归档拒绝导入、路径映射冲突、并发任务恢复和凭据不跨域发送；避免通过匹配源代码文本判断功能是否存在。

## 数据库与发行

数据库内容变更后，更新 database-manifest.json 的 bytes、sha256 和 snapshot，再执行 npm run verify:resources。数据库更新必须通过临时文件校验后原子替换。

版本号同时更新 package.json 和 package-lock.json。运行 npm run dist 生成 dist/release 下的 Windows x64 安装包；不会自动发布。GitHub 的 Build Windows installer 工作流可手动执行，产物包含安装包和两个数据库文件。发布到 Releases 时附带这两个数据库文件，才能启用该版本的数据库在线更新。

阶段性工作使用中文约定式提交，例如 refactor(backup): 拆分快照索引。发行说明写在 GitHub Releases，不维护额外 changelog。合并前检查 Windows CI，并在真实存档的副本上完成一次手动备份恢复验证。
