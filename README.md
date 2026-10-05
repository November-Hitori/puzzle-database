# PuzArchive prototype

这是 Puzzle Database 的前端原型，当前使用静态 HTML、CSS 和 JavaScript 演示首页、题库、题目页、题集和文件管理的信息架构。

## 本地运行

在项目目录执行（数据库模式）：

```powershell
npm run dev
```

然后打开 <http://localhost:4173/>。第一次启动会自动创建 `data/puzarchive.sqlite`，并写入演示题目、评分、完成记录和文件夹。

也可以使用任意静态文件服务器运行 `index.html`；这种方式不会连接数据库，前端会回退到浏览器 `localStorage` 演示模式。

## 当前数据库接入

项目使用 Node.js 内置的 `node:sqlite`，不需要额外安装 PostgreSQL 或 ORM。数据库层位于 [db.mjs](db.mjs)，HTTP API 位于 [server.mjs](server.mjs)。

API 包括：

- `GET /api/puzzles`：题目、完成状态、评分平均值和评分人数
- `POST /api/puzzles`：创建外链题目或纯填空题
- `POST /api/puzzles/:number/complete-rating`：写入完成记录和三个维度评分
- `POST /api/puzzles/:number/tags`：给题目添加标签
- `GET /api/folders`：读取文件夹
- `POST /api/folders`：创建文件夹，可指定上级文件夹
- `GET /api/collections`：读取题集列表
- `GET /api/collections/:id`：读取题集详情、题目顺序和 IB/PB/SB 资料

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
- 登录、通知、搜索等演示入口
- 桌面端和移动端响应式样式

## 下一阶段

- 使用 Next.js 或其他正式应用框架拆分页面和组件
- 将 SQLite 迁移到 PostgreSQL 与 ORM（需要多人部署或生产环境时）
- 将当前演示用户替换为真实账户和用户 ID
- 实现邮箱验证码、密码哈希、Session 和权限控制
- 接入真实的题目添加、标签、留言板、题集和递归文件夹管理 API
- 使用受信任的嵌入策略处理 puzz.link / penpa+ 页面，必要时回退到新标签页打开
- 增加自动化测试、迁移脚本和生产部署配置
