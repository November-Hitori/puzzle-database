# PuzArchive prototype

这是 Puzzle Database 的私有谜题档案。Node.js 提供 SQLite API 和静态前端；首次注册需要共享邀请码，注册后使用用户名和密码登录。

## 本地运行

需要 Node.js 22.13 或更新版本。在项目目录运行：

```powershell
npm run dev
```

然后打开 <http://localhost:4173/>。第一次启动会自动创建 `data/puzarchive.sqlite`，并生成一个仅供注册使用的邀请码至 `data/trusted-users.json`。服务会尝试将该文件权限设为仅当前用户可读写（0600）；在 `/mnt/c` 等 Windows/WSL 挂载目录上，Unix 权限可能无法生效，实际访问由 Windows ACL 控制。请将工作区放在仅可信用户可访问的位置，并确认该文件继承了合适的 Windows ACL。该文件被 Git 忽略。将共享邀请码通过私下方式交给对应成员；同一个邀请码可供多名成员注册，不会因注册而消耗。之后使用用户名和密码登录，不需要邮箱验证。不要把邀请码或密码放到 shell 命令行，也不要提交它们。

已有部署在第一次升级启动时，会按当前 `trusted-users.json` 一次性导入唯一成员身份和共享邀请码，并清除旧会话。第一次成功注册会继承原成员 UUID 和显示名，因此既有题目、完成记录和评分仍属于该身份；之后注册的账号获得独立身份。迁移后数据库成为账号与注册码的权威来源；JSON 仅保留作私密备份，之后编辑它不会增删账号或撤销注册码。使用部署 CLI 轮换/停用共享注册码或停用账号，具体命令见 [部署管理说明](docs/deployment.md#membership-and-accounts)。

服务默认只绑定 `127.0.0.1`。有明确的可信网络部署时可设置 `HOST` 和 `PORT`。应用 API 都需要登录；数据库模式下不要用静态服务器代替本服务。

## 当前数据库接入

项目使用 Node.js 内置的 `node:sqlite`，不需要额外安装 PostgreSQL 或 ORM。数据库层位于 [db.mjs](db.mjs)，HTTP API 位于 [server.mjs](server.mjs)。

API 包括：

- `POST /api/register`：使用共享邀请码注册用户名/密码并自动建立私有会话
- `GET /api/session`、`POST /api/session`、`DELETE /api/session`：查询会话、使用用户名/密码登录和销毁会话
- `/api/rules`：读取、创建和更新规则草稿；可分组提交名称、双语说明与 Penpa 例题审计
- `/api/calendar/puzzles`：读写独立日历题目、完成评分、标签和上传者设置的建议日期
- `/api/puzzles`、`/api/folders`、`/api/collections`、`/api/tags`：现有公共题库管理 API，只包含公共题目

共享邀请码可注册多个独立账号。用户名按 Unicode NFKC 规范化并以小写键保证唯一，长度为 2–32 个 Unicode 字符（字母、数字、下划线或连字符）；密码为 12–128 个 Unicode 字符且不超过 512 UTF-8 字节。密码使用带随机盐的 scrypt 哈希存储（N=131072、r=8、p=1），服务不保存明文密码；浏览器只持有 HttpOnly、SameSite=Strict 的会话 Cookie。提交操作校验同源来源。用环境变量 `PUZARCHIVE_DB_PATH`、`PUZARCHIVE_USERS_PATH` 可指定隔离数据库和成员配置路径（也用于测试）。

评分在数据库中按用户保存：`puzzle_ratings(puzzle_id, user_id, logic, intuition, enjoyment)`。题库的三项评分由 SQL `AVG` 聚合产生，而不是由浏览器计算。

规则草稿创建时只要求至少填写中文或英文名称之一及分类；缺少的另一种名称、任一语言说明、Penpa 例题或有效变体基础规则会由服务端列为质量错误。例题仅接受带具体题目载荷的受支持 Penpa URL。名称、双语说明（含变体关系）和例题分别需要三名不同的有效账号通过；提交者也可参与，但同一账号不会重复计票。拒绝会阻止该组通过，直到实际修改该组内容；修改只重置该组当前审计，旧版本决定与建议继续保留。分类不参与三组审计。

## 当前入口

- 邀请码门控注册、用户名/密码登录和私有会话
- 日历谜题列表，按个人完成状态筛选未完成题目
- 日历谜题提交、建议日期与规则选择
- 个人完成状态、评分与规则浏览
- 桌面和移动端布局

旧版首页、公共题库、题集、文件夹、作者和个人记录界面已从当前入口隐藏；既有 SQLite 内容会保留，不会因界面隐藏而删除。

## 本地测试

```sh
npm test
```

后端测试使用临时 SQLite 数据库，不会读取或写入 `data/puzarchive.sqlite`。

## SQLite 数据

升级会向既有数据库添加日历范围、规则引用、建议日期、提交者、规则目录、可信用户和会话表；原题目、评分、完成记录、文件夹和题集均会保留。启动升级前建议复制 `data/puzarchive.sqlite` 作备份。已有题目保持公共范围且不会被猜测或翻译规则。

## 私有服务器部署

服务器部署使用专用系统用户和 Node.js 22.23.3，SQLite 与历史成员配置保存在应用目录之外，并每日创建私有备份。应用仅监听 `127.0.0.1:4173`；临时邀请测试入口通过 Nginx 与短期 IP HTTPS 证书提供。详见 [docs/deployment.md](docs/deployment.md)，包括 SSH 直连配置与关闭临时入口的步骤。代码变更、独立验收和生产发布顺序见[贡献与发布工作流](docs/contribution-workflow.md)。

## 后续工作

- 使用 Next.js 或其他正式应用框架拆分页面和组件
- 将 SQLite 迁移到 PostgreSQL 与 ORM（需要多人部署或生产环境时）
- 增加账号密码恢复流程
