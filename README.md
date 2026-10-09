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
- `/api/calendar/puzzles`：读写独立日历投稿；完成记录包含 1–6 难度、六种可选评价标签，以及 `-2`、`-1`、`0`、`1`、`2` 喜爱程度评分或 `veto`。至少三名不同成员评分且未四舍五入的平均分严格大于 0 后通过；否决会转入可重新投稿的待处理区。旧客户端的 `support` / `oppose` 输入分别按 `2` / `-2` 处理
- `/api/calendar/puzzles/:number/comments`：登录成员可独立留言，包括否决后；已完成成员直接读取，未完成者默认隐藏，主动查看时使用 `?reveal=1`
- `PATCH /api/calendar/puzzles/:number`：投稿者可修改名称、链接，携带 `expectedEditVersion` 和 `expectedReviewRound`；`clearReviews` 默认 `false`，为 `true` 时删除所有轮次的难度、标签、投票并开启新轮次，保留完成记录和留言
- `POST /api/calendar/puzzles/:number/assignment`：成员分配或取消正式日期，携带 `expectedEditVersion`、`expectedReviewRound` 与 `assignedDate`（完整日期或 `null`）；非通过题目、年份不符、无效日期和日期冲突均拒绝
- `POST /api/calendar/puzzles/:number/penpa-audits`：对当前 `revision`、`guidelinesRevision` 提交 `approve` / `reject` 和可选建议；重复投票不重复计数
- `POST /api/rules/:id/error-ignores`、`POST /api/calendar/puzzles/:number/error-ignores`：以当前错误的 `key`、`revision` 提交 `ignored` 和可选 `reason`；错误对应内容改版后旧忽略不适用
- `GET /api/penpa-guidelines`：读取制图规范正文与规范版本
- `/api/inbox`：读取账号的系统通知（不是私聊），包括已知规则创建者的审计结果和投稿者的日历状态通知；支持标记单条或全部已读
- `/api/puzzles`、`/api/folders`、`/api/collections`、`/api/tags`：现有公共题库管理 API，只包含公共题目

共享邀请码可注册多个独立账号。用户名按 Unicode NFKC 规范化并以小写键保证唯一，长度为 2–32 个 Unicode 字符（字母、数字、下划线或连字符）；密码为 12–128 个 Unicode 字符且不超过 512 UTF-8 字节。密码使用带随机盐的 scrypt 哈希存储（N=131072、r=8、p=1），服务不保存明文密码；浏览器只持有 HttpOnly、SameSite=Strict 的会话 Cookie。提交操作校验同源来源。用环境变量 `PUZARCHIVE_DB_PATH`、`PUZARCHIVE_USERS_PATH` 可指定隔离数据库和成员配置路径（也用于测试）。

评分在数据库中按用户保存：`puzzle_ratings(puzzle_id, user_id, logic, intuition, enjoyment)`。题库的三项评分由 SQL `AVG` 聚合产生，而不是由浏览器计算。

登录成员可在题目详情查看评分者名称，以及日历投稿各轮各分值评分者和否决者的名称。评分者跨轮次只列一次，喜爱评分名单按分值和轮次展示；名称优先显示用户名，旧账号使用保留的显示名。成员访问权限保持不变。

规则草稿创建时只要求至少填写中文或英文名称之一及分类；缺少的另一种名称、中文说明、Penpa 例题或有效变体基础规则会由服务端列为质量错误。英文说明可留空，不会仅因缺少英文而产生质量错误；说明组仍按正常的三人审计状态显示待审计警告。若提供英文说明，其内容变化仍会重置说明审计。例题仅接受带具体题目载荷的受支持 Penpa URL，例题作者可选且属于例题审计内容。名称、中文说明（英文可选，含变体关系）和例题分别需要三名不同的有效账号通过；提交者也可参与，但同一账号不会重复计票。拒绝会阻止该组通过，直到实际修改该组内容；修改只重置该组当前审计，旧版本决定与建议继续保留。分类不参与三组审计。

## 当前入口

- 邀请码门控注册、用户名/密码登录和私有会话
- 待审核区、leftover 区、待分配区和按月份展示的完成区，以及可追溯的逐轮投票/评价历史
- 日历谜题提交：默认 2028 年；分别填写 Penpa 编辑、Penpa 解题和 puzz.link 链接。外链投稿至少提供一种解题链接，编辑链接可后补；建议日期不占正式档期，投稿者由登录账号确定
- 个人完成状态、评分与规则浏览
- 至少三名不同成员评分且未四舍五入的平均分严格大于 0 后通知上传者补齐缺少的 Penpa 链接；正式日期不得重复，取消分配后回到待分配区
- Penpa 制图规范独立接受三名不同成员审计，规范正文或 Penpa 链接变化后需重新审计；具体规范见 [docs/penpa.md](docs/penpa.md)
- 规则与题目的质量错误可明确忽略或恢复，记录忽略者、理由和版本；忽略不替代三人审计
- 未完成题目的平均难度和留言默认以剧透标记遮挡，点击后查看
- 规则原型使用支持中英文搜索及键盘选择的下拉框
- 规则审计和题目评价只返回被修改的条目；前端局部更新并显示提交中状态，评价题目时保留解题 iframe
- 桌面和移动端布局

旧版首页、公共题库、题集、文件夹、作者和个人记录界面已从当前入口隐藏；既有 SQLite 内容会保留，不会因界面隐藏而删除。

## 本地测试

```sh
npm test
```

后端测试使用临时 SQLite 数据库，不会读取或写入 `data/puzarchive.sqlite`。

真实桌面浏览器验收使用 [tools/browser-check.mjs](tools/browser-check.mjs)。它在随机 loopback 端口启动真实服务，并创建隔离账号和 SQLite；不读取既有账号或数据库。需要已安装的 Chromium，以及单独的 Playwright 核心测试驱动，应用本身不增加第三方依赖。例如在 Bash 中：

```sh
npm install --prefix /tmp/puzarchive-browser-test --no-save --package-lock=false playwright-core
export PUZARCHIVE_PLAYWRIGHT_MODULE=/tmp/puzarchive-browser-test/node_modules/playwright-core/index.mjs
export PUZARCHIVE_BROWSER_EXECUTABLE=/path/to/chromium
export PUZARCHIVE_BROWSER_SCREENSHOT_DIR=docs/screenshots
npm run test:browser
```

本工作区可用 `bash ../start-puzarchive.sh test:browser` 自动选择本地 Node.js 22 运行时。若 Chromium 需要从独立目录加载系统库，设置 `PUZARCHIVE_BROWSER_LIB_DIR`。受限执行环境需要允许浏览器启动和本机端口监听。测试覆盖注册登录、剧透、留言失败恢复、延迟投票、局部审计、搜索选择、错误忽略、四区流转和日期分配；外部解题平台以隔离测试页面替代，因此不把其加载状态当作验收结果。


## SQLite 数据

升级会向既有数据库添加日历审核轮次、评价、投票与系统通知收件箱元数据；旧日历评分仅作为第一轮难度的初始评价，旧评分、完成时间、题目 ID 和规则快照均保留，且迁移不会生成历史投票或通知。新一轮会保留每一轮的最终投票、评价和完成记录。升级还会按可识别的平台和模式保留并拆分旧链接，原始链接、题目 ID、规则快照、审核状态和完成记录保留；原建议日期不会自动转为正式分配日期。对外 `calendarStatus` 继续记录社区投票状态，`calendarArea` 根据质量和日期动态计算为 `review`、`leftover`、`allocation` 或 `finished`；规则审核状态发生变化后会重新计算。制图规范从工作区根目录 `docs/penpa.md` 或发行包的 `docs/penpa.md` 读取，测试可用 `PUZARCHIVE_PENPA_GUIDELINES_PATH` 指定隔离文本。本次升级会一次性删除旧中立投票、其中立投票所在轮次的难度与标签评价和中立投票事件；完成记录及其他投票、评价保留，可重新评价。清理逻辑位于 `calendar-review-migration.mjs`。启动升级前建议先创建在线备份。已有题目保持原范围且不会被猜测或翻译规则。

## 私有服务器部署

服务器部署使用专用系统用户和 Node.js 22.23.3，SQLite 与历史成员配置保存在应用目录之外，并每日创建私有备份。应用仅监听 `127.0.0.1:4173`；临时邀请测试入口通过 Nginx 与短期 IP HTTPS 证书提供。详见 [docs/deployment.md](docs/deployment.md)，包括 SSH 直连配置与关闭临时入口的步骤。代码变更、独立验收和生产发布顺序见[贡献与发布工作流](docs/contribution-workflow.md)。

规则表格的安全解析、链接校验、预览与显式导入步骤见[批量导入规则](docs/deployment.md#bulk-rule-import)。原始工作簿和解析出的私有载荷不得提交到 Git。

## 后续工作

- 使用 Next.js 或其他正式应用框架拆分页面和组件
- 将 SQLite 迁移到 PostgreSQL 与 ORM（需要多人部署或生产环境时）
- 增加账号密码恢复流程

## CI/CD

生产发布由 `Sigmit64/puzzle-database` 的 GitHub Actions 自动执行：代码通过 PR 提交并经独立 GPT-6 Luna high reviewer 验收（不额外要求 GitHub 人工批准），完整测试、真实桌面浏览器验收和只读发行包预检通过后合并到 `main`，再备份、原子发布及数据保留校验。上游仓库只运行 CI。配置与运行命令见 [docs/ci-cd.md](docs/ci-cd.md)。

## 用户名与共同补链接

登录后可在右上角“修改用户名”中改名，使用新用户名及原密码登录；身份 ID、所有评价/完成记录和现有会话保留。名称按 Unicode NFKC 规范化，大小写不敏感且不能与其他账号重复，提交携带原用户名以检测并发修改。当前用户名会同步成为账号显示名，规则审核、留言和投票名单优先显示用户名。

待分配区题目的“补充或修改 Penpa 链接”面向所有登录成员。该入口只修改 Penpa 编辑/解题链接，不可修改题目名称、puzz.link 链接、投稿身份或清除评价；新链接版本需要重新完成制图审计，既有做题评价、轮次历史和日期分配保留。待审核、leftover 和完成区不开放共同链接编辑；投稿者仍可使用原完整编辑入口。

puzz.link 投稿字段支持当前工具列表中的整个家族：puzz.link、pzplus.tck.mn、pzprxs.vercel.app、pzv.jp。各站点必须使用对应的具体题目 URL；不接受站点首页、伪装域名、带账号凭据的链接或 Penpa 链接误填。
