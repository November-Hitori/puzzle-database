# PuzArchive prototype

这是 Puzzle Database 的私有谜题档案。Node.js 提供 SQLite API 和静态前端；访问应用内容前需要使用受信任成员的邀请码登录。

## 本地运行

需要 Node.js 22.13 或更新版本。在项目目录运行：

```powershell
npm run dev
```

然后打开 <http://localhost:4173/>。第一次启动会自动创建 `data/puzarchive.sqlite`，并生成一位可信成员的独立邀请码至 `data/trusted-users.json`。服务会尝试将该文件权限设为仅当前用户可读写（0600）；在 `/mnt/c` 等 Windows/WSL 挂载目录上，Unix 权限可能无法生效，实际访问由 Windows ACL 控制。请将工作区放在仅可信用户可访问的位置，并确认该文件继承了合适的 Windows ACL。该文件被 Git 忽略。将邀请码通过私下方式交给该成员。加入成员时，在这个 JSON 数组中添加唯一 `id`、显示名 `name` 和至少 16 个字符的随机 `accessCode`，然后重启服务；移除成员或更换其邀请码也需重启，并会使其已有会话失效。请勿将邀请码粘贴到终端命令或提交到 Git。

服务默认只绑定 `127.0.0.1`。有明确的可信网络部署时可设置 `HOST` 和 `PORT`。应用 API 都需要登录；数据库模式下不要用静态服务器代替本服务。

## 当前数据库接入

项目使用 Node.js 内置的 `node:sqlite`，不需要额外安装 PostgreSQL 或 ORM。数据库层位于 [db.mjs](db.mjs)，HTTP API 位于 [server.mjs](server.mjs)。

API 包括：

- `GET /api/session`、`POST /api/session`、`DELETE /api/session`：查询、建立和销毁私有会话
- `GET /api/rules`、`POST /api/rules`：读取规则目录和新增规则；变体必须引用原始规则
- `/api/calendar/puzzles`：读写独立日历题目、完成评分、标签和上传者设置的建议日期
- `/api/puzzles`、`/api/folders`、`/api/collections`、`/api/tags`：现有公共题库管理 API，只包含公共题目

邀请码对应独立可信身份，浏览器只持有 HttpOnly、SameSite=Strict 的会话 Cookie。提交操作校验同源来源。用环境变量 `PUZARCHIVE_DB_PATH`、`PUZARCHIVE_USERS_PATH` 可指定隔离数据库和成员配置路径（也用于测试）。

评分在数据库中按用户保存：`puzzle_ratings(puzzle_id, user_id, logic, intuition, enjoyment)`。题库的三项评分由 SQL `AVG` 聚合产生，而不是由浏览器计算。

## 当前已实现

- 独立首页，题库不再作为默认首页
- 首页工作台包含公告和到题库、题集列表、索引/文件管理的入口，已移除推广式 Hero 文案
- 题库首页布局、导航、公告和概览数据
- 题目列表、完成状态、作者、标签和三维评分展示
- 独立题目页：`#puzzle-编号`
- `puzz.link`、`penpa+` 外链入口和题目预览区域
- 纯填空题的内置答案输入与检查演示
- 完成后一次提交“逻辑难度、通灵难度、喜爱程度”三个评分
- 题库显示三项评分的聚合平均值，并展示评分人数
- 最近添加、题号和评分排序按钮
- 逻辑题、文字题、已完成和 Wrong Puzzle 筛选
- 题目添加时校验 `puzz.link` / `penpa+` 外部链接
- 题目页支持添加标签，标签保存到 SQLite
- 文件管理页，支持来源、年份、题集的文件夹展示和新建文件夹
- 题集列表、独立题集详情、题目顺序和 IB/PB/SB 资料栏
- 我的记录和作者页面
- 通知和搜索等演示入口
- 桌面端和移动端响应式样式
- 使用受信任的嵌入策略处理 puzz.link / penpa+ 页面，必要时回退到新标签页打开

## 本地测试

```sh
npm test
```

后端测试使用临时 SQLite 数据库，不会读取或写入 `data/puzarchive.sqlite`。

## SQLite 数据

升级会向既有数据库添加日历范围、规则引用、建议日期、提交者、规则目录、可信用户和会话表；原题目、评分、完成记录、文件夹和题集均会保留。启动升级前建议复制 `data/puzarchive.sqlite` 作备份。已有题目保持公共范围且不会被猜测或翻译规则。

## 私有服务器部署

服务器部署使用专用系统用户和 Node.js 22.23.3，SQLite 与成员配置保存在应用目录之外，并每日创建私有备份。当前只监听服务器本机 `127.0.0.1:4173`，通过 SSH 本地转发访问；未配置公网入口。详见 [docs/deployment.md](docs/deployment.md)。

## 后续工作

- 使用 Next.js 或其他正式应用框架拆分页面和组件
- 将 SQLite 迁移到 PostgreSQL 与 ORM（需要多人部署或生产环境时）
- 接入真实的留言板、题集和递归文件夹管理 API
- 增加生产部署配置
