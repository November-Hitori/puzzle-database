# PuzArchive prototype

这是 Puzzle Database 的私有谜题档案。Node.js 提供 SQLite API 和静态前端；首次注册需要共享邀请码，注册后使用用户名和密码登录。

## 本地运行

应用需要 Node.js 22.13 或更新版本。批量工作簿准备与其测试还需要 Python 3 标准库（生产服务本身不依赖 Python）。在项目目录运行：

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
- `/api/rules`：读取、创建、更新和删除规则；可分组提交名称、中文说明（英文可选）与 Penpa 例题审计。存在公共题目、日历题目或变体引用时不能删除
- `/api/calendar/puzzles`：读写独立日历投稿；完成记录包含 1–6 难度、六种可选评价标签，以及 `support`、`neutral`、`oppose` 或 `veto` 每轮投票。净支持达到 3 票后通过，否决会转入可重新投稿的待处理区
- `/api/inbox`：读取账号的系统通知（不是私聊），包括已知规则创建者的审计结果和投稿者的日历状态通知；支持标记单条或全部已读
- `/api/puzzles`、`/api/folders`、`/api/collections`、`/api/tags`：现有公共题库管理 API，只包含公共题目

共享邀请码可注册多个独立账号。用户名按 Unicode NFKC 规范化并以小写键保证唯一，长度为 2–32 个 Unicode 字符（字母、数字、下划线或连字符）；密码为 12–128 个 Unicode 字符且不超过 512 UTF-8 字节。密码使用带随机盐的 scrypt 哈希存储（N=131072、r=8、p=1），服务不保存明文密码；浏览器只持有 HttpOnly、SameSite=Strict 的会话 Cookie。提交操作校验同源来源。用环境变量 `PUZARCHIVE_DB_PATH`、`PUZARCHIVE_USERS_PATH` 可指定隔离数据库和成员配置路径（也用于测试）。

评分在数据库中按用户保存：`puzzle_ratings(puzzle_id, user_id, logic, intuition, enjoyment)`。题库的三项评分由 SQL `AVG` 聚合产生，而不是由浏览器计算。

规则草稿创建时只要求至少填写中文或英文名称之一及分类；缺少的另一种名称、中文说明、Penpa 例题或有效变体基础规则会由服务端列为质量错误。英文说明可留空，不会仅因缺少英文而产生质量错误；说明组仍按正常的三人审计状态显示待审计警告。若提供英文说明，其内容变化仍会重置说明审计。例题仅接受带具体题目载荷的受支持 Penpa URL，例题作者可选且属于例题审计内容。名称、中文说明（英文可选，含变体关系）和例题分别需要三名不同的有效账号通过；提交者也可参与，但同一账号不会重复计票。拒绝会阻止该组通过，直到实际修改该组内容；修改只重置该组当前审计，旧版本决定与建议继续保留。分类不参与三组审计。

## 当前入口

- 邀请码门控注册、用户名/密码登录和私有会话
- 日历谜题列表、待重新进入投稿和可追溯的逐轮投票/评价历史
- 日历谜题提交：默认 2028 年，可不选月份和日期；服务器根据登录账号记录投稿者
- 个人完成状态、评分与规则浏览
- 桌面和移动端布局

旧版首页、公共题库、题集、文件夹、作者和个人记录界面已从当前入口隐藏；既有 SQLite 内容会保留，不会因界面隐藏而删除。

## 本地测试

```sh
npm test
```

后端测试使用临时 SQLite 数据库，不会读取或写入 `data/puzarchive.sqlite`。

## SQLite 数据

升级会向既有数据库添加日历审核轮次、评价、投票与系统通知收件箱元数据；旧日历评分仅作为第一轮难度的初始评价，旧评分、完成时间、题目 ID 和规则快照均保留，且迁移不会生成历史投票或通知。新一轮会保留每一轮的最终投票、评价和完成记录。启动升级前建议先创建在线备份。已有题目保持原范围且不会被猜测或翻译规则。

## 私有服务器部署

服务器部署使用专用系统用户和 Node.js 22.23.3，SQLite 与历史成员配置保存在应用目录之外，并每日创建私有备份。应用仅监听 `127.0.0.1:4173`；临时邀请测试入口通过 Nginx 与短期 IP HTTPS 证书提供。详见 [docs/deployment.md](docs/deployment.md)，包括 SSH 直连配置与关闭临时入口的步骤。代码变更、独立验收和生产发布顺序见[贡献与发布工作流](docs/contribution-workflow.md)。

规则表格的安全解析、链接校验、预览与显式导入步骤见[批量导入规则](docs/deployment.md#bulk-rule-import)。原始工作簿和解析出的私有载荷不得提交到 Git。

## 后续工作

- 使用 Next.js 或其他正式应用框架拆分页面和组件
- 将 SQLite 迁移到 PostgreSQL 与 ORM（需要多人部署或生产环境时）
- 增加账号密码恢复流程

## Next.js preview

Next.js migration files are available in `app/`, `components/`, and `lib/`. The legacy Node service remains the default entry point.

```powershell
npm run dev:next
```

Then open <http://localhost:4173/>. The Next preview uses its own database at `data/next/puzarchive.sqlite` and does not modify the legacy database.

```powershell
npm run build:next
npm run start:next
```
