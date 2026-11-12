# 程序层设计（v1.0 · 冻结）

> 本文件是程序结构的**唯一权威说明**。GUI 开发方只需要读 `docs/SERVICE_API.md`，不需要改动 `src/`。

## 1. 分层与依赖方向

```
┌──────────────────────────────────────────────────────────────┐
│ 表现层        web/  (HTML/CSS/ESM，由 GUI 开发方实现)          │
│                    ↑ HTTP + SSE   ↓                            │
│ 服务层        src/server.mjs     src/cli.mjs                   │
│                    ↑                                           │
│ 流程层        src/pipeline.mjs                                 │
│                    ↑                                           │
│ 能力层        src/core/*   src/sources/*   src/subs/*          │
│                    ↑                                           │
│ 基础设施      src/net/http.mjs   node:sqlite / node:fs         │
└──────────────────────────────────────────────────────────────┘
```

**依赖只能向上**：`web → server → pipeline → {core, sources, subs} → net`。任何下层不得 import 上层。

| 层 | 模块 | 职责 | 禁止 |
|---|---|---|---|
| 服务层 | `src/server.mjs` | REST + SSE、任务队列、静态站点 | 不含业务规则 |
| 服务层 | `src/cli.mjs` | 命令行入口 | 不含业务规则 |
| 流程层 | `src/pipeline.mjs` | 扫描→解析→元数据→改名→字幕→落库 | 不含站点选择器 |
| 能力层 | `core/code` | 文件名→番号候选 | 不联网 |
| 能力层 | `core/template` | 命名模板/清洗 | 不联网 |
| 能力层 | `core/rename` | 计划/执行/日志/回滚 | 不联网 |
| 能力层 | `core/state` | SQLite 状态机 | 不含业务判断 |
| 能力层 | `sources/javbus`、`sources/manko` | 元数据抓取与解析 | 不直接改名 |
| 能力层 | `subs/*` | 字幕搜索/下载/校验/落地 | 不直接改名 |
| 基础设施 | `net/http` | HTTPS + 路由分流 + 代理 + cookie + 重试 | 不含站点知识 |

## 2. 文件读写边界（硬约束）

- **只读文件名与元数据**：扫描、识别、重命名、幂等判定只使用 `readdir` / `stat`（文件名、大小、mtime）。
- **常规识别不分析视频画面**：扫描与编号识别只使用文件名和文件信息；可选 FFprobe 探测时长。v0.8.0 超级拼装由用户显式启动后读取媒体、探测字幕、封装并校验输出指纹，见 §13。
- 唯一读取内容的地方是**下载到内存的字幕字节**（用于编码识别/结构校验），以及写入 `.srt`。
- 因此：10GB 文件与 10MB 文件处理耗时一致；不会触发磁盘 IO 放大。

## 3. 数据流 / 状态机

```
discovered → code? ──no──→ no_code（终态）
                │
                ├─ scope≠censored → out_of_scope（终态）
                ↓
           javbus/manko 确认 ──失败──→ unresolved（下次重试）
                ↓
          plan（dry-run）→ apply：rename + journal
                ↓
          字幕：manko ZH → subtitlecat -zh-CN
                │
                ├─ 找到且校验通过 → ok
                └─ 没有简体 → no_subtitle（终态，禁止顶替/机翻）
```

状态持久化在 `data/state.db`（`files/codes/subtitles` 三张表），用于续跑与幂等。

## 4. 稳定性设计（已通过 37 文件压力测试）

| 机制 | 实现 | 参数 |
|---|---|---|
| 单文件隔离 | `try/catch` + `withTimeout` | `--file-timeout` 默认 180s |
| 熔断 | N 个连续失败即中止整批 | `--max-failures` 默认 5 |
| 续跑 | 逐文件落库，重启跳过已完成 | 自动 |
| 幂等 | 已规范命名 + 同尺寸 → 不重复改名/下载 | 自动 |
| 用户取消 | SIGINT / API cancel → 完成当前文件后停 | 自动 |
| 网络路由 | 直连/代理 两路由，失败自动切换 + 10 分钟粘滞记忆 | 配置 |
| 限速 | 每 host 最小间隔，防止封禁 | `minIntervalMs` 1200 |
| 重试 | 网络错误 + 429/5xx 指数退避 | `retry` 3 |
| 回滚 | 一次运行一个 journal，含落地的 `.srt` | 自动 |
| 预检 | `run` 前探测 javbus/subtitlecat | `--no-preflight` 可跳过 |
| 并发 | 文件级并发，默认 1，最大 4 | `--concurrency` |

## 5. 配置（`config.json`，运行时可覆盖）

优先级：**命令行参数 > 环境/接口参数 > config.json > 内置默认值**。

```jsonc
{
  "network": { "proxy": "...", "proxyHosts": [...], "directHosts": [...],
               "defaultRoute": "direct", "timeoutMs": 20000, "retry": 3, "minIntervalMs": 1200 },
  "rename":  { "template": "{code} {title} [{actress}]", "maxLength": 170 },
  "subs":    { "lang": "zh", "sources": ["manko","subtitlecat"], "maxDurationDeltaMin": 5 },
  "scan":    { "videoExtensions": [".mp4", ...] },
  "paths":   { "dataDir": "data" }
}
```

GUI 的设置页只允许改：`network.proxy`、`rename.template`、`subs.sources`、`paths.dataDir`。其余字段由后端维护。

## 6. 扩展点（不影响现有调用）

- **新增元数据源**：在 `src/sources/` 加 `xxx.mjs`，实现 `{search(code), detail(url)}`，在 `pipeline.resolveMeta` 的源列表里注册。
- **新增字幕源**：实现 `{name, find(code), download(found)}`，加入 `createContext` 的 `subs` 数组。
- **新增服务端接口**：只加在 `src/server.mjs` 的 `route()`，遵循 `docs/SERVICE_API.md` 的错误格式。

## 7. 冻结声明

- 本设计的**模块边界、目录结构、状态机、配置格式**自 v1.0 起冻结。
- 任何破坏性变更（改函数签名、改状态值、改 API 字段）必须升级次版本号并在 `CHANGELOG.md` 记录。
- GUI 开发**只允许新增** `web/**`；`src/**`、`config.json` 的结构、`docs/**` 均为只读。

## 8. 视频内容读取边界（v1.1 补充）

§2 的「不读取视频内容」仍然有效：扫描/识别/重命名/幂等判定只用文件名与 `stat` 元数据。

唯一例外是**可选**的媒体扩展（默认关闭 `covers.embed=false`）：
- `src/media/ffmpeg.mjs` 在用户显式开启嵌入时调用外部 ffmpeg/ffprobe 处理视频容器
- 未安装 ffmpeg 时模块整体降级（`detectFfmpeg() -> null`），不影响字幕与改名流程
- 封面下载只写旁车文件（`<视频名>.jpg`），不修改视频

## 9. v0.6 增量说明（不改变分层与目录结构）

- **预演可信（F1）**：`pipeline.configSignature(config)` 为影响结果的配置子集生成签名；
  `shouldSkipFile()` 决定是否跳过（dry-run 仅在签名未变时跳过、apply 仅在"已应用且签名未变"时跳过）。
  状态库 `data` 新增 `planSig` / `stage` / `rename` 字段（表结构未变）。
- **撤销一致性（F4）**：`undoJournal` 改为「先还原视频 → 删本次写入的旁车 → 还原 `.avc-bak-*` 备份」；
  服务端撤销成功后用 `state.resetFile/deleteFile` 同步状态库。
- **单文件预演（F8）**：`/api/preview` 复用 `processFile(..., persist:false)`，不写盘、不建任务。
- **实测片长（F7）**：`config.media.probeDuration` 控制是否用 ffprobe 校准 `meta.durationSec`（仍不读视频内容做识别）。
- **可观测（F6/F9）**：`/api/diagnose` 汇总网络/ffmpeg/dataDir/配置检查；任务落 `data/jobs/<id>.json`，重启可恢复。
- 依赖方向、模块边界、状态机与配置格式均未改变；新增能力均通过 §6 的扩展点接入。

## 10. v0.7 增量说明

- **新增元数据源 r18.dev**（F15）：`src/sources/r18.mjs` 实现 `{findByCode}`，在 `resolveMeta` 中排在 javbus 之后、
  manko 之前；`config.metadata.r18` 可关闭。站点不可达时只记日志，不影响主流程。
- **无番号反查**（F16）：`src/sources/lookup.mjs` 用 manko 关键词搜索返回番号候选，服务端 `POST /api/lookup`，
  GUI 抽屉里可直接选候选并预演。
- **多语言附加字幕**（F17）：`config.subs.extraLangs`，apply 时在主简体之后写 `<stem>.<lang>.srt`；
  journal 记 `srtExtra`/`srtExtraBackup` 可撤销。
- **可观测性**（F19）：`<dataDir>/logs/avc-*.log`（14 天）、崩溃日志、`/api/diagnostics/export` 脱敏诊断包。
- **发布工程**（F18/F21）：`tools/check-release.mjs`、`tools/build-docs-zip.mjs`、`tools/lib/zip.mjs`、
  白名单打包 + `VERSION.json`；`package.json` 版本为唯一来源（服务端运行期读取）。
- **数据安全**（F22）：`state.db` `user_version` 迁移 + 迁移前自动备份；`avc backup` / `avc restore`；
  journal 版本校验。表结构与分层未变。
- **测试基建**（F20）：`tests/helpers/factory.mjs` 合成夹具，无 `fixtures/` 时解析类用例也会执行；
  `server.mjs`/`cli.mjs` 导出可导入入口。
- **手动字幕/封面（v0.7.1）**：`src/subs/manual.mjs` 复用各字幕源的 `listCandidates/download`，
  提供"只列候选"与"安装选中项"（校验、备份、journal、时间轴校正）；服务端 `POST /api/subtitles/{candidates,apply}`
  与 `POST /api/cover/fetch`；任务运行中拒绝（409）。封面计划 `coverPlanned` 随状态库持久化。
- **配置与运维（v0.7.2）**：`src/core/backup.mjs`（CLI 与 GUI 共用的备份/恢复）；服务端
  `/api/backup`、`/api/backups`、`/api/restore`、`/api/subtitle/preview`；
  设置页接线 `subs.extraLangs`、`metadata.r18`、`media.probeDuration` 与字幕源启用；
  `POST /api/lookup` 改为 javbus 关键词搜索（支持演员名/标题片段）+ manko 番号回退。

## 11. v0.7.4 外观与氛围（仅前端）

- `web/appearance.js` / `web/appearance.css` 独立管理外观。左下角图片按钮先展开快捷小菜单；点击「更多设置」再展开四页完整面板，两者互斥，入口位置固定。
- 背景调色、面板材质、樱花天气与本地时间氛围仅影响呈现，不修改任务、媒体文件、后端 API 或业务配置。
- 偏好保存在当前浏览器的 `avc.appearance.v2`（兼容旧 `avc.bg.v1`）；本地图片压缩后保存在 IndexedDB `avc-wallpapers` 的 `images` 表。后端备份不包含浏览器外观数据。
- 时间氛围读取电脑本地时间，无联网或定位；可选深色联动只作用于自动主题。花瓣使用 CSS 动画，失焦或后台暂停，并遵循系统减少动态效果设置。
- `web/updates.js` / `web/updates.css` 使用原生 `<dialog>` 展示正式更新日志：按版本从新到旧逐版列出日期及分类摘要，正文独立滚动，标题与底部操作固定。`avc.updates.dismissed` 仅记录用户勾选不再提示的版本；顶部版本号或设置页可重新查看，浏览器提供模态焦点约束。版本覆盖、顺序与日期由测试与 CHANGELOG / package.json 对照校验。
- `web/sakura.js` 管理不叠加、限时清理的花雨彩蛋，与持久天气偏好独立；失焦、后台或开启减少动态效果会结束花雨。`web/assets/sakura-branch.svg` 为本地矢量装饰，角落装饰开关随 `branches` 外观偏好保存。
- `web/preferences.js` 管理语言与字号偏好（`avc.ui.v1`）；`web/i18n.js` 只翻译仓库维护的界面文字与模板片段，文件名、标题元数据、字幕和历史日志不进入翻译流程。`web/locales/en.js` 保存英文界面文案。所有界面文本字号按同一比例缩放，浏览器级偏好与业务配置分离。

## 12. v0.7.5 工作流层

- `src/core/workflow.mjs` 提供固定计划、缺项磁盘校验、冲突策略与 HTML 报告；`web/workflow.js` 与 `web/workflow.css` 提供对应面板，沿用现有主题与语言设置。
- 状态库 schema v3 使用 records/corrections（旧 issue_ignores 表保留但不再使用）；人工修正以文件 ID 隔离，程序改名与撤销转移映射，外部替换不按番号继承。
- plans 保存配置、选择、字段版本、指纹、主字幕及最终目标；应用引用 ID/revision，执行前与逐文件再次校验。附加语言维持既有应用时查询规则，提前固定配置及目标占位。
- jobs 保留普通串行执行、取消、部分结果和历史；重启未完成记录转 aborted，不自动继续。新增队列管理、文件快照和问题聚合 / 忽略已撤回。
- src/core/maintenance.mjs 限定清理查询 / 字幕分析 / 封面代理缓存；web/maintenance.js 提供确认、维护状态与重连。src/core/gui-supervisor.mjs 管理自身服务子进程，空闲重启后保留端口、host、配置和 cwd；导入式服务器默认无重启权限。
- web/work-panel.js 配合 side-scroll 独立滚动，应用操作固定底部，适配视口、字体与窄屏。
- journal v1 增加 sidecarOnly 条目，未改名的字幕/封面操作也支持恢复；视频流重写仍不在本版范围。
- 数据备份同步包含 plans；候选分析临时缓存不备份。API 与契约增量见 SERVICE_API/CONTRACTS §19；交付说明见 V075_WORKFLOWS。
- 目录配置档废案。v0.8 字幕嵌入与图片反查的实现见 §13；Whisper / 机翻暂缓。

## 13. v0.8.0 超级拼装

- `web/assembly.js` / `web/assembly.css` 提供独立工具页，继承主题变量和语言偏好，图片结果只复制番号。
- `src/core/assembly.mjs` 将本地素材发现、真实路径授权、操作计划、封装执行和 v2 媒体撤销隔离于改名管线；普通工作台行为保持原契约。
- `src/media/mux.mjs` 使用无 shell 的 spawn 参数数组调用用户提供的 FFmpeg / FFprobe，复制原轨并新增字幕；显式保留时间戳，比较抽取后的归一化字幕，流式计算输出 hash。
- 原输出默认另存 .softsub；独立临时目录 → 校验 → 记录 publishing 指纹 → 原子硬链接拒绝覆盖 → published。旧日志不升级；v2 日志按输出 hash / 身份保护撤销，源文件不迁移人工修正。
- 普通 job 增加 mux 分支，SSE 和持久历史复用；忙时拒绝新封装，不引入问题中心或队列管理。取消等待进程 close，重启中断的任务不自动续跑。
- `src/core/assembly-settings.mjs` 保存独立公开配置和不回传密钥；`src/net/upload.mjs` 使用有界单次 POST，独立于 GET 重试器。`src/sources/frame-search.mjs` 校验图片、构建 multipart file 并清洗结果。
- 浏览器先重编码图片、去元数据并显示最终字节；只有点击搜索才上传。后端不落盘图片或结果，不获取远程缩略图。上传可取消、可走 CONNECT 代理，禁止重试和重定向。
- `src/core/assembly-report.mjs` 提供媒体专用 HTML；备份增加 assembly/plans，排除工具配置、密钥及媒体输出。完整边界见 V080_SUPER_ASSEMBLY。

## 14. v0.8.1 更多动效（实验中）

2026-11-10 的视觉增量与 2026-11-11 的可靠性修复已统一归入 0.8.1，详见 [CHANGELOG](../CHANGELOG.md#081---2026-11-11)。文件、状态、取消、备份与网络修订以 [模块合同 §21](CONTRACTS.md#21-2026-11-11-文件与服务安全修订) 和 [公开验证范围](V081_RELIABILITY.md) 为准，限定验证不等于完整验收。

- `web/effects-bootstrap.js` 在首屏绘制前读取独立模式偏好 `avc.effects.v1` 与初始 hash 页面；首次默认关闭，不替换 `avc.theme.v1` 或 `avc.appearance.v2`。
- `web/effects.js` 管理开关、导航选中胶囊、背景加载、页面交接与播放状态。`app.js` 在 `showView()` 中通知模式模块；初始页面在等待后端健康检查前确定。
- `web/effects.css` 通过 `data-effects` / `data-effects-view` 限定新配色与材质，保持工作台与业务控件的原结构。启用时隐藏主题与自定义外观入口，简洁模式仍保留已有功能。
- `appearance.setSuspended()` 挂起／恢复原有时钟、壁纸轮播与天气；`sakura.setSuspended()` 终止并挂起花雨。偏好、壁纸收藏及业务配置不由模式切换重置。
- 四张 `web/assets/effects/*.jpg` 为本地静态原图；独立 CSS 层呈现花瓣、光尘、蝶形光影及柔光。仅当前页面播放，不使用持续 JavaScript 帧循环；页面隐藏、失焦与减少动态效果分别暂停或回退。
- 开启模式且使用精细鼠标时，背景按鼠标位置反向偏移（水平 ±12px、垂直 ±8px），16px 余量避免露边；每批移动事件只请求一次帧更新，CSS 负责平滑过渡。离开、失焦、隐藏、关闭模式及输入设备变化时复位；触屏和减少动态效果不启用视差。
- 浏览器支持时使用原生画面过渡；缺少该能力时保留轻量切换。图片加载后再交接，过时页面请求失效；背景模糊不可用时保留较实的导航底色。
- 不增加服务端 API、后端持久数据或运行依赖，不修改媒体操作契约；启动动画和独立场景 Demo 没有在此增量中改动。
- 使用与验证范围见 [MORE_EFFECTS.md](MORE_EFFECTS.md)。`tools/check-effects-ui.mjs` 为可选开发检查，使用隔离配置与数据，Playwright 不进入应用运行依赖。


