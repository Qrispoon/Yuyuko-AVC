# GUI 后端 API v1.0（冻结 / FROZEN）

- 服务：`node src/server.mjs --port 17890 [--open]`
- 默认监听 `127.0.0.1`；这是本机协作工具，没有新增账号/会话鉴权。2026-11-11 修订统一校验实际监听地址的 Host、变更请求 Origin 和路由 Content-Type；不从请求 Host 推导可信来源。
- 全部 JSON：`Content-Type: application/json; charset=utf-8`；请求体最大 1MB
- 错误统一格式：`{ "error": "<code>", "message"?: "<detail>", ... }`
- 稳定错误码：`dir_required` `dir_not_found` `journal_required` `job_not_found` `report_not_ready` `invalid_config` `body_too_large` `forbidden` `not_found`
- v0.6 新增错误码：`file_required` `file_not_found` `not_video` `preview_failed`（`/api/preview`）；
  `job_finished`（取消已结束任务）；`task_running`（运行中撤销）；`undo_failed` 的 `reason` 扩展见 §6

v0.8.1（2026-11-11）收录本次安全与可靠性修订，并优先于下文历史版本叙述，详见 `CONTRACTS.md §21` 和 [V081_RELIABILITY.md](V081_RELIABILITY.md)。正常无 Origin 的本地 JSON 请求兼容；不可信 Host/Origin 返回 403，错误 Content-Type 返回 415。图片搜索只接受其规定 image MIME。启动器在公共端口执行相同校验后，才把已验证的 Host/Origin 改为内部 worker 地址。关闭中拒绝新写，冲突写操作由数据目录所有权返回 409；取消入口仍可中止拥有的任务。

---

## 1. 健康检查

`GET /api/health` → `200`

```json
{ "ok": true, "version": "0.8.1", "node": "v26.13.0", "platform": "win32",
  "proxy": "http://127.0.0.1:7890", "dir": "<项目路径>",
  "running": null, "queued": 0 }
```

## 2. 配置

`GET /api/config` → `200`，返回 `config.json` 全文（结构见 `docs/ARCHITECTURE.md §5`）。

`PUT /api/config` 请求体为**部分配置**（浅合并），例如：

```json
{ "network": { "proxy": "http://127.0.0.1:7890" } }
```

→ `200` 返回合并后的完整配置；`400 invalid_config` 表示不是对象。

> GUI 设置页只应修改 `network.proxy`、`rename.template`、`subs.sources`、`paths.dataDir`。

## 3. 扫描（不联网）

`POST /api/scan`

```json
{ "dir": "D:\\Videos" }
```

→ `200`

```json
{
  "dir": "D:\\Videos", "count": 37, "ms": 12,
  "items": [{
    "path": "D:\\Videos\\xxx.mp4", "name": "xxx.mp4", "size": 10291529,
    "code": "IPX-920", "scope": "censored", "score": 17,
    "normalized": false,
    "candidates": [{ "code": "IPX-920", "score": 17, "scope": "censored" }],
    "notes": ["ad-domain"]
  }]
}
```

- `code` 为 `null` 表示未识别；`scope !== 'censored'` 表示 FC2/HEYZO/素人（流程会跳过）。
- **v0.6 新增字段**：每个 item 额外返回
  - `applied: boolean`：状态库里该文件是否已真正应用（预演不算）
  - `stage: 'plan'|'apply'|null`：最近一次处理阶段
  - `rename: { from, to, action, reason?, batchConflict? } | null`：目标改名计划（`action` 同 `planRenames`：`rename|skip_same|skip_duplicate|skip_conflict`）
  - `duplicates: string[]`：同目录内**同一番号**的其它文件绝对路径（F3，空数组表示无重复）
  - `coverPlanned: { url, targetPath } | null`：预演阶段算出的封面下载计划（v0.7.1）
- 目录不存在/不是目录 → `400 {error:"dir_not_found"}`。

## 4. 任务

### 4.1 创建任务

`POST /api/jobs`

```json
{
  "kind": "plan",
  "dir": "D:\\Videos",
  "options": {
    "limit": 0,
    "force": false,
    "downloadSubs": true,
    "concurrency": 1,
    "fileTimeoutMs": 180000,
    "maxConsecutiveFailures": 5
  }
}
```

| 字段 | 说明 |
|---|---|
| `kind` | `"plan"`（预演，不动磁盘）\| `"apply"`（改名+落字幕） |
| `options.limit` | 0 = 全部 |
| `options.force` | 忽略状态库重跑 |
| `options.downloadSubs` | false = 只改名不下字幕 |
| `options.concurrency` | 文件级并发，1–4（默认 1） |
| `options.fileTimeoutMs` | 单文件超时，默认 180000 |
| `options.maxConsecutiveFailures` | 连续失败熔断阈值，默认 5 |
| `options.only` | 只处理这些绝对路径（v0.7.5 严格遵守选择范围，空数组不处理文件，overrides 不再扩大范围） |
| `options.overrides` | `{ "<文件绝对路径>": "番号" }`，手动补录番号，仅本次任务 |

> v0.6：`force` 的语义是"连已应用过的文件也重新处理"；未传 `force` 时是否跳过由
> `pipeline.shouldSkipFile` 决定（配置签名 `configSignature` 未变才跳过，见 `docs/CONTRACTS.md §15`）。

→ `202`

```json
{ "jobId": "e3b0c442-...", "job": { "id": "...", "kind": "plan", "dir": "...",
  "status": "queued", "createdAt": 1794043000000, "logCount": 0 } }
```

- 任务状态：`queued | running | done | aborted | cancelled | failed | needs_review`（v0.7.5）
- 同一时间只跑一个任务，其余排队。

### 4.2 任务列表 / 详情

`GET /api/jobs` → `{ "jobs": [ publicJob, ... ] }`（jobs 按创建时间倒序；旧 paused/order 字段已撤回）

`GET /api/jobs/:id` → `publicJob`

```json
{
  "id": "...", "kind": "apply", "dir": "...", "options": {},
  "status": "done", "createdAt": 0, "startedAt": 0, "finishedAt": 0,
  "summary": { "ok": 32, "no_code": 3, "out_of_scope": 2 },
  "progress": { "done": 37, "total": 37 },
  "error": null, "logCount": 120, "reportJson": "data/run-....json",
  "journal": "data/journal-....json"
}
```

### 4.3 取消

`POST /api/jobs/:id/cancel` → `200 publicJob`

- `queued` 直接取消；`running` 会在**当前文件完成后**停止（不影响已完成的文件与 journal）。
- 任务已是 `done` / `aborted` / `cancelled` / `failed` → `409 {error:"job_finished"}`（v0.6）。

### 4.4 实时事件（SSE）

`GET /api/jobs/:id/events` → `text/event-stream`

```
data: {"type":"snapshot","job":{...},"tail":[{t,line},...]}

data: {"type":"job-started","job":{...}}
data: {"type":"log","line":"[1] xxx.mp4","t":1794043000123}
data: {"type":"start","dir":"...","total":37,"apply":false}
data: {"type":"file-start","index":1,"total":37,"file":"...","name":"..."}
data: {"type":"file-done","index":1,"status":"ok","code":"IPX-920",
       "newName":"IPX-920 ... [明里つむぎ].mp4","name":"@nya2p....mp4",
       "result":{...}}
data: {"type":"file-error","index":2,"name":"...","error":"FILE_TIMEOUT: ..."}
data: {"type":"file-skipped","name":"...","status":"ok"}
data: {"type":"done","summary":{...},"cancelled":false,"aborted":null,
       "durationMs":17600,"journal":"data/journal-....json"}
data: {"type":"job-finished","job":{...}}
```

- 事件流在 `job-finished` 后由服务端关闭；前端应处理断线重连（`retry: 3000` 已声明）。
- 服务端每 15s 发 `: ping` 注释帧保活。
- 前端**只需处理** `log / file-done / job-finished`（其余可忽略或用于进度条）。
- **v0.6 新增**：
  - SSE 事件里的 `job` 对象带 `progress: {done,total}`；`snapshot` 可直接用于恢复进度。
  - 连接一个**已结束**的任务时，服务端先补发 `snapshot`，再补发一条 `job-finished`，然后立即 `end()`（不再挂起长连接）。前端可用它把"运行中"状态收尾。

### 4.5 报告 / 日志

`GET /api/jobs/:id/report` → `200` 完整 run report（同 CLI 的 `run-*.json`）；未完成 → `404 report_not_ready`。

`GET /api/jobs/:id/log` → `{ "id": "...", "logs": [{ "t": 0, "line": "..." }] }`

## 5. 状态库

`GET /api/state?dir=<可选目录>` → `200`

```json
{ "counts": { "ok": 32, "no_code": 3 },
  "files": [{ "path": "...", "name": "...", "status": "ok", "code": "IPX-920",
              "newName": "...", "subPath": "...srt", "exists": true, "error": null,
              "stage": "apply", "applied": true, "planSig": "v06-1a2b3c4d" }] }
```

- v0.6 新增字段：`stage`（`plan` / `apply` / `null`）、`applied`（是否真正应用过，预演为 `false`）、
  `planSig`（配置签名；用于判断上次预演是否已过期）。

## 6. 历史与回滚

`GET /api/journals` → `{ "journals": [{ "file": "data/journal-x.json", "createdAt": "...", "items": 32 }] }`（最多 50 条）

`POST /api/undo` → 请求 `{ "journal": "data/journal-x.json" }`（相对路径基于 `paths.dataDir`）

→ `200`

```json
{ "journal": "D:\\...\\data\\journal-x.json", "restored": 32, "removed": 30, "failed": [] }
```

- `failed` 元素含 `{to,from,reason}`，例如 `target_missing / source_busy / content_changed / sidecar_changed: ... / backup_changed_or_missing / legacy_unverifiable`。冲突文件和不可信备份保留，不按路径直接删除。
- 新普通日志为 `type:file-operations,version:1`；无 type 的旧日志缺少历史证据，默认 `legacy_unverifiable`，不自动移动视频或旁车。独立 `mux-create-output/v2` 仍分派给成片撤销器，未知 type/version 拒绝。
- 响应包含 `restoredItems`（本次恢复的视频路径）、`completedItems`（旁车也完成的项）、`videoDoneItems`（持久化的视频步骤检查点）、`restoredExtras`、`reset`、`undoComplete`、`retainedEffects` 和可选 `stateError`。`restored > 0` 不表示完整成功。
- 视频路径步骤完成后，即使旁车冲突，也迁回同一个 records.id 并保留字段锁和修订历史；清除已有 files 应用状态与旧目标幽灵行。投影按 operationId 幂等；重复撤销不清后来工作。数据库失败返回 `stateError / undoComplete:false`，再次撤销可补记。
- `retainedEffects:["embedded_cover"]` 表示嵌入封面和当前媒体字节保留，不能恢复嵌入前内容；部分撤销也返回此字段。GUI/CLI 须显示该限制和部分失败。
- 撤销先恢复可验证视频路径，再将未变化的本次旁车移到隔离路径，恢复可信 `.avc-bak-*`。每步持久保存，重复调用仅继续未完成步骤。
- 任务运行或其他写所有者占用时 → `409 {error:"task_running",message}`。
- 失败时返回 `400 {error:"undo_failed", message}`。

## 7. 静态站点

`GET /` → `web/index.html`；`GET /<path>` → `web/<path>`（`web/` 内路径穿越 → 403）。

`web/` 未构建时返回 `404 {error:"not_found"}`。

## 8. 示例（curl / PowerShell）

```powershell
# 扫描
curl.exe -s -X POST http://127.0.0.1:17890/api/scan -H "Content-Type: application/json" `
  --data-binary '{"dir":"D:\\Videos"}'
# 建任务
curl.exe -s -X POST http://127.0.0.1:17890/api/jobs -H "Content-Type: application/json" `
  --data-binary '{"kind":"plan","dir":"D:\\Videos"}'
# 看事件
curl.exe -N http://127.0.0.1:17890/api/jobs/<jobId>/events
```

> Windows PowerShell 5.1 的 `Invoke-WebRequest` 发送中文路径会乱码，调试请用 `curl.exe` 或 Node 的 `fetch`。

## 9. 只读文件系统 API（目录选择器）

用于让 GUI 在浏览器里**浏览磁盘目录**（只列目录/文件元数据，不读内容、不写、不删）。
权限由 `config.json → fs` 控制：

```json
"fs": { "enabled": true, "allowedRoots": [], "maxEntries": 5000, "showFiles": true }
```

- `allowedRoots` 为空 = 自动允许本机所有盘符根目录；填写数组则只允许这些前缀（如 `["D:\\","E:\\Videos"]`）
- 越界路径返回 `400 {error:"fs_forbidden"}`

### 9.1 `GET /api/fs/roots`

```json
{ "enabled": true, "drives": ["C:\\","D:\\","E:\\"], "allowedRoots": ["C:\\", "..."], "platform": "win32" }
```

### 9.2 `GET /api/fs/list?path=D:\\Videos`

```json
{
  "dir": "D:\\Videos", "parent": "D:\\", "truncated": false,
  "entries": [
    { "name": "合集", "path": "D:\\Videos\\合集", "isDir": true, "size": null, "mtimeMs": 0, "ext": null },
    { "name": "IPX-920.mp4", "path": "D:\\Videos\\IPX-920.mp4", "isDir": false, "size": 10291529, "mtimeMs": 0, "ext": ".mp4" }
  ]
}
```

- 目录在前、按中文排序；跳过隐藏项与系统目录；`parent` 为 `null` 表示已到根
- 目录不存在 → `400 {error:"dir_not_found"}`

### 9.3 `GET /api/fs/check?path=...` → `{ path, exists, isDir, isFile }`

### 9.4 `POST /api/fs/pick-folder` → 弹 Windows 原生目录选择框（**GUI 已不使用**）

> ⚠️ 实测：由后台/无窗口方式启动的后端，其创建的窗口会落在不可见桌面上，表现为「点了没反应」。
> 因此正式界面已**移除系统对话框按钮**，目录选择统一走 §9.2 的内置浏览器（支持盘符切换）。
> 该接口保留给命令行/诊断使用，行为如下：

```json
{ "path": "D:\\Videos", "allowed": true }
```

- 用户取消 → `200 { "cancelled": true }`
- 后端进程没有交互桌面（例如由后台/无窗口方式启动）→ **`409 {error:"no_interactive_desktop"}`**（前端应立即切换到内置目录浏览器）
- 对话框 45 秒内无响应（可能被挡在其它窗口后）→ **`504 {error:"native_dialog_timeout"}`**
- PowerShell 不可用等其它失败 → `500 {error:"native_dialog_failed", message}`
- 该接口是**可选增强**；纯浏览器方案用 §9.2 自绘目录浏览器即可（推荐：界面默认走 §9.2）

### 9.5 `GET /api/fs/pick-capable` → `{ "interactive": true|false, "hint": string|null }`

用于前端在点击「系统对话框」前先判断能力：`interactive=false` 时直接打开内置目录浏览器，避免等待。

> 安全边界：FS API 只做目录列表与元数据读取（`readdir`/`stat`），不提供读取文件内容、写入、删除、移动。

## 10. 封面与媒体能力（v1.1 新增）

### 10.1 `GET /api/cover?url=<encoded>` —— 远程封面代理

浏览器直连 javbus 图片域名会被墙/防盗链拦截，所以缩略图统一走服务端代理：

- 200：图片字节，`Content-Type` 为真实类型；服务端按 URL 缓存 1 小时
- 400 `invalid_url` / 502 `cover_fetch_failed` / 502 `not_image` / 413 `file_too_large`

### 10.2 `GET /api/cover?path=<本地绝对路径>` —— 本地封面

读取 `covers.download` 落地的 `<视频名>.jpg`；限制在 `fs.allowedRoots` 内、≤12MB。

### 10.3 `GET /api/media/health`

```json
{ "ffmpeg": { "available": false, "version": null },
  "covers": { "download": true, "embed": false, "embedReady": false } }
```

`embedReady` 只有在 ffmpeg 可用且 `covers.embed=true` 时才为 true。

### 10.4 `POST /api/scan` 返回值增强（v1.1）

每个 item 额外携带状态库信息：`status`、`newName`、`meta`（含 `coverUrl`）、`sub`（含 `source/cues/candidates/fit`）、`cover`（含 `path/posterPath/embedded`）。GUI 可直接用来渲染缩略图与已处理状态。

### 10.5 配置项新增（v0.4.1）

`config.subs.subtitlecatLimit`（1–12，默认 4）：subtitlecat 每个番号最多探测多少个中文候选。
越大越慢、越可能找到时长更贴合的字幕；GUI 设置页可直接修改并 PUT /api/config 保存。

---

## 11. 自检诊断（v0.6 新增）

`GET /api/diagnose` → `200`

```json
{
  "ok": true, "version": "0.8.1", "node": "v26.13.0", "platform": "win32",
  "network": { "proxy": "http://127.0.0.1:7890", "defaultRoute": "direct",
    "hosts": [{ "name": "javbus", "url": "https://www.javbus.com/", "ok": false,
                "status": 0, "ms": 1200, "route": "proxy", "error": "TIMEOUT" }] },
  "ffmpeg": { "available": true, "version": "6.0", "ffprobe": true },
  "dataDir": { "path": "D:\\...\\data", "writable": true, "error": null },
  "config": { "path": "D:\\...\\config.local.json", "valid": true,
              "unknownKeys": [], "warnings": ["network.autoDiscover 已在配置中，但当前版本未生效"] },
  "state": { "db": "D:\\...\\state.db", "files": 0, "byStatus": {} },
  "logs": { "dir": "D:\\...\\data\\logs", "latest": "avc-2026-11-08.log" }
}
```

- `network.hosts`：固定探测 4 个关键域名（javbus / manko / subtitlecat / 封面 CDN），并行、单项失败不影响接口；
  `route` 为本次实际使用的路由（direct/proxy），`error` 为稳定错误码（`TIMEOUT` 等）。
- `dataDir`：`mkdir -p` 后写/删一个 `.avc-probe` 文件验证可写性；只有一个临时文件副作用。
- `config.unknownKeys` 列出配置里 schema 之外的键（跨节用 `network.xxx` 表示）；
  `warnings` 提示模板里存在但当前版本未生效的配置项（`network.autoDiscover`、`rename.stripActressFromTitle`、
  `subs.writeSiblingSrt`、`scan.skipNormalized`）。
- 接口本身始终 `200`，不会因为网络/ffmpeg/state 异常而失败。

## 12. 单文件预演（v0.6 新增）

`POST /api/preview`

```json
{ "file": "D:\\Videos\\IPX-920.mp4", "code": "IPX-920", "downloadSubs": true }
```

- `file`：绝对路径（必填）；`code`：可选，手动番号覆盖；`downloadSubs`：默认 `true`。
- 行为：**不写盘、不建任务、不落状态库**（只读取状态库/元数据缓存），内部复用 `processFile(apply:false, persist:false)`，
  120 秒保护。
- → `200`

```json
{ "file": "D:\\Videos\\IPX-920.mp4", "name": "IPX-920.mp4", "status": "ok", "code": "IPX-920",
  "candidates": [{ "code": "IPX-920", "score": 17, "scope": "censored", "rule": "std", "known": true }],
  "meta": { "titleJa": "...", "actress": ["..."], "durationSec": 7200, "durationSource": "probe" },
  "newName": "IPX-920 ... [明里つむぎ].mp4",
  "rename": { "from": "D:\\Videos\\IPX-920.mp4", "to": "D:\\Videos\\IPX-920 ....mp4", "action": "rename" },
  "sub": { "source": "manko", "cues": 1234, "targetPath": "..." },
  "coverPlanned": { "url": "...", "targetPath": "..." } }
```

- 错误：`400 file_required` / `400 not_video`（扩展名不在 `scan.videoExtensions`）/ `400 file_not_found` /
  `500 preview_failed`（含 `message`，不外泄栈）。

---

## 14. 无番号反查（v0.7 新增）

`POST /api/lookup`

```json
{ "keyword": "明里つむぎ", "limit": 10 }
```

- `keyword` 必填（≤200 字符），可以是标题片段、演员名或番号；`limit` 1–50，默认 10。
- 搜索后端（v0.7.2 修正）：优先 **javbus 关键词搜索**（支持日文演员名与标题片段，返回番号/标题/封面/发行日期；
  实测「明里つむぎ」可返回 29 个候选）；javbus 不可用或 0 结果时回退 manko（manko 只匹配番号）。
  结果按 `canonCode` 去重；输入本身是番号时精确项优先，其余按发行日期倒序。
- → `200`

```json
{ "keyword": "明里つむぎ",
  "candidates": [{ "code": "FNS-257", "movieId": null, "title": "… 明里つむぎ",
                   "releaseDate": "2026-10-22", "maker": null,
                   "coverUrl": "https://www.javbus.com/pics/thumb/cmj3.jpg", "source": "javbus" }] }
```

- `source` ∈ `javbus` | `manko`（manko 命中时带 `movieId`）。
- 错误：`400 keyword_required` / `400 keyword_too_long` / `502 lookup_failed`（两个源都不可用）。
- 该接口只读：不写盘、不落状态库。

## 15. 诊断包导出（v0.7 新增）

`GET /api/diagnostics/export?job=<jobId>&redact=1`

- 返回 `application/json` 附件（`Content-Disposition: attachment; filename="avc-diagnostics-<ts>.json"`），
  用于让用户把可排查信息附到 Issue，避免手工收集。
- `redact` 默认 `1`：递归把字符串里的 Windows 绝对路径（`X:\...`）替换为 `<path>`；传 `0` 则保留原样（仅本机排查用）。
- `job` 可选：带上某任务的公开信息与 `report.summary`（任务不存在时忽略）。
- 载荷：

```json
{ "generatedAt": "2026-11-11T12:00:00.000Z", "version": "0.8.1", "node": "v26.13.0",
  "platform": "win32", "arch": "x64",
  "diagnostics": { "network": { "...": "..." }, "ffmpeg": { "...": "..." }, "dataDir": { "...": "..." },
                   "config": { "...": "..." }, "state": { "...": "..." }, "logs": { "...": "..." } },
  "config": { "...": "配置副本（已去掉 paths）" },
  "logs": ["2026-11-08T... INFO ...", "..."],
  "job": { "id": "...", "kind": "plan", "status": "done", "summary": { "ok": 1 } } }
```

- 错误：`500 diagnostics_failed`（极少见，构造诊断数据失败）。接口不写任何新文件。

## 16. 服务端日志（v0.7 新增）

- 日志文件：`<dataDir>/logs/avc-YYYY-MM-DD.log`，行格式 `ISO8601 LEVEL message`（LEVEL: INFO/WARN/ERROR）。
- 启动时清理 14 天前的 `avc-*.log`；`uncaughtException` 会写 `<dataDir>/logs/crash-<ts>.log` 后退出进程，
  `unhandledRejection` 写崩溃日志但继续运行。
- GUI 设置页可通过「导出诊断包」拿到日志尾部（见 §15）。

---

## 17. 手动字幕与封面（v0.7.1 新增）

详情抽屉里可以手动挑选字幕、手动补下封面。写操作与任务/CLI 共用数据目录所有权；冲突返回 `409 task_running`。安装/封面写入会保存类型化事务和状态，候选列表本身不写媒体。

### 17.1 `POST /api/subtitles/candidates`

请求：`{ "file": "<视频绝对路径>", "code": "IPX-920"?, "limit": 12? }`

- `code` 缺省时取：状态库该文件的番号 → 文件名识别出的第一个番号；都没有 → `400 code_required`。
- 返回 `200`：`{ file, code, contextToken, candidates: [{ source, lang, name, url, localPath, sizeHint, contextToken, candidateIndex }] }`
  - `source` ∈ `manko` / `subtitlecat` / `local`（按 `config.subs.sources` 顺序）
  - 只列候选，不安装字幕、不改媒体；可刷新记录身份与查询状态。单个源失败不影响其它源。
- 错误：`400 file_required` / `400 file_not_found` / `400 not_video` / `400 code_required` / `409 task_running` / `500 subtitles_failed`

### 17.2 `POST /api/subtitles/apply`

请求：`{ "file": "...", "code": "IPX-920", "candidate": <候选列表返回的完整对象> }`

- 行为：校验 token、文件/记录修订/来源/指纹与候选完整内容 → 下载（或读 `localPath`）→ 编码归一化和时间轴处理 → 所有语言最终结构/时序校验 → 写前日志及旁车证据 → 排他备份/写入 → 更新状态。无旧日志条目时创建 sidecarOnly 事务；旧日志不原地升级。
- 候选 token 一小时有效；错文件、修订/来源/指纹变化或改候选返回 409。客户端应重新列候选，不能把旧候选移到当前抽屉文件。
- 返回 `200`：`{ path, bytes, cues, verdict, lang, warnings, backup, journal, fit }`
- 错误：`400 candidate_required` / `400 subtitle_rejected`（`reason` 为 `empty` / `not_srt` / `download_failed`）/
  `409 task_running` / `500 subtitles_failed`

### 17.3 `POST /api/cover/fetch`

请求：`{ "file": "...", "url": "https://..."? }`

- `url` 缺省时取状态库该文件的 `meta.coverUrl`；都没有 → `400 cover_url_missing`。
- 行为：下载封面 → 备份已有同名封面 / poster → 写 `<视频名>.jpg|png|webp`（单视频目录同时写 `poster.*`）
  → 记入 journal（若可）→ 更新状态库。
- 返回 `200`：`{ path, posterPath, bytes, backup }`
- 错误：`400 file_required` / `400 file_not_found` / `400 not_video` / `400 cover_url_missing` / `400 invalid_url` /
  `409 task_running` / `502 cover_fetch_failed`

---

## 18. 备份/恢复与预览（v0.7.2 新增）

### 18.1 `POST /api/backup`

请求：`{ "dest": "D:\\Backup" }`（可选；缺省写到 `<dataDir>/backups`）

- 使用 `VACUUM INTO` 生成独立 state.db 快照，不复制 WAL/SHM；连同 journal/run/jobs/plans/assembly 和 v2 hash manifest 写入全新 `dest/avc-backup-<ts>/`（同名目录自动加 `-2`）。
- `409 task_running`（任务运行中不允许备份）；`dest` 越界 → `400 fs_forbidden`。
- → `200 { "path": "<备份目录>", "files": 12 }`；失败 `500 backup_failed`。

### 18.2 `GET /api/backups`

→ `200 { "backups": [{ "dir": "...", "name": "avc-backup-...", "files": 12, "createdAt": 1794... }] }`
（只列 `<dataDir>/backups/avc-backup-*`，最近 20 个，倒序）

### 18.3 `POST /api/restore`

请求：`{ "dir": "<备份目录绝对路径>", "force": false }`；中断恢复请求 `{ "recover": true }` 不需要 dir。

- 校验目录存在且含 `state.db` → 否则 `400 invalid_backup`；目录不存在 → `400 dir_not_found`。
- 校验快照完整性/schema/manifest；缺少 manifest 的旧 WAL/SHM tuple 拒绝自动恢复。目标已有任一 state.db/WAL/SHM 时默认整代跳过，返回 `generationSkipped:true`，不能只补历史文件。
- `force:true` 在无已登记状态连接并持有写所有权时切换整代；先阶段化并保存 intent，保留旧代，返回 `retained`。中断时阻止正常开库，显式 recover 验证摘要后回滚/确认提交。未知外部所有者不自动清理。
- `409 task_running`。
- → `200 { "copied": 12, "skipped": 0, "retained": "..." }`；恢复返回 `{recovered,committed?,reason?,retained?}`。无待恢复项为 `{recovered:false,reason:"no_pending_restore"}`；失败 `500 restore_failed`。

### 18.4 `GET /api/subtitle/preview?path=<srt>&lines=30`

- `path` 必填；须在 `fs.allowedRoots` 内；只接受 `.srt`；≤ 8MB。`lines` 1–200（默认 30）。
- → `200`

```json
{ "path": "D:\\Videos\\IPX-920.srt", "bytes": 30976, "encoding": "utf-8",
  "count": 668, "lastEndSec": 7212.3, "truncated": true,
  "cues": [{ "index": 1, "start": "00:00:01,000", "end": "00:00:03,500", "text": "第一句" }] }
```

- 错误：`400 path_required` / `400 fs_forbidden` / `400 not_srt` / `404 not_found` / `413 file_too_large` /
  `500 subtitle_preview_failed`

## 13. 任务历史持久化（v0.6 新增）

- 快照入队前复制并按 seq 串行保存到 `<dataDir>/jobs/<id>.json`（含公开字段、最近 2000 行日志、完整 report）。先持久报告，再持久终态快照，之后才公开 done/failed/cancelled 和 job-finished；保存失败不能宣称成功。
- **服务重启后**，`GET /api/jobs` / `GET /api/jobs/:id` / `/log` / `/report` 仍能读到历史任务（最近 100 条）。
- 重启时仍是 `running` / `queued` 的持久记录标记为 `aborted`，`error = "interrupted_by_restart"`，保留部分结果但不恢复执行；请重新预演。
- 历史任务不占进程内存队列；只有新任务会重新排队。



## 19. v0.7.5 工作流接口（向后兼容增量）

旧接口继续可用。新版 GUI 的应用必须带固定计划；所有文件路径为绝对路径，错误仍遵循统一 JSON 格式。

### 19.1 固定计划与任务创建

预演请求在 `options` 中新增：

```json
{
  "workflow": {
    "mode": "missing",
    "metadata": true,
    "subtitles": true,
    "covers": true,
    "extraSubtitles": true,
    "rename": false
  }
}
```

- `mode` 为 `complete | missing`；missing 默认保留名称，只有显式 `rename:true` 才重新命名。
- `downloadSubs:false` 与 `workflow.subtitles:false` 任一关闭主字幕；附加语言为独立选项，语言列表取配置。
- 创建任务时固定配置、文件集合、stat 指纹和人工修订；之后新增目录文件不会加入已排队任务。
- 完成的预演 report 新增 `planId / planRevision`。计划包含解析后的元数据、最终目标和主字幕缓存。附加语言仍按既有行为只在应用阶段查询，但目标占位和配置固定。
- `GET /api/plans/:id`：读取计划；响应不含内部配置和字幕 base64。
- `POST /api/plans/:id`：带当前 `revision`，可选 `decisions` 或 `candidateToken / file`。修改返回新 revision；旧 revision 返回 `409 plan_changed`。

冲突策略示例：

```json
{
  "revision": 0,
  "decisions": {
    "D:\\Videos\\IPX-920.mp4": {"strategy": "suffix"},
    "D:\\Videos\\IPX-921.mp4": {"strategy": "custom", "name": "IPX-921 Custom.mp4"},
    "D:\\Videos\\IPX-922.mp4": {"strategy": "skip"}
  }
}
```

确认应用：

```json
{
  "kind": "apply",
  "dir": "D:\\Videos",
  "options": {"only":["D:\\Videos\\IPX-920.mp4"],"force":false,"downloadSubs":true,"workflow":{"mode":"missing"},"requirePlan":true,"planId":"<uuid>","planRevision":1}
}
```

应用请求必须携带与预演相同的 only/overrides/force/downloadSubs/workflow；上例省略的选项也须按预演原值发送。dir、请求选项、实际集合、源文件、旁车、修正版本或目标占用不符时，在消费前转为 `needs_review`；已消费计划不能复用。单文件操作若与当前批计划不同，应先生成独立单文件预演，再确认应用。兼容旧调用的无 planId 应用仍存在，新集成应始终发送 requirePlan。

### 19.2 任务管理精简

新增队列面板及专用 API 已撤回。POST /api/queue 返回 404；GET /api/jobs 仅返回 jobs，不再含 paused/order，公开任务不再含 position/fileCount 或内部 snapshot。保留普通 FIFO 串行执行、取消、SSE 与历史，不支持暂停、排序、复核重入队或排队时文件快照。

needs_review 仍用于已确认计划过期，表示需要重新预演；重启中断记录标为 aborted，不自动续跑。旧 queue-state.json 不再读取。

### 19.3 人工修正

`GET /api/corrections?file=<绝对路径>` → `{record,source,history}`。

`POST /api/corrections`：

```json
{
  "file": "D:\\Videos\\IPX-920.mp4",
  "revision": 0,
  "fields": {
    "titleJa": {"value": "修正标题", "locked": true},
    "actress": {"value": ["出演"], "locked": true}
  },
  "codeLocks": "keep"
}
```

- fields 是本文件人工字段全集，允许 code/titleJa/titleZh/actress/releaseDate/maker/coverUrl。
- 日期为有效 YYYY-MM-DD；封面链接仅 HTTP(S) 且不含凭据。演员为字符串数组。
- 刻意留空并锁定有效；删除字段表示恢复来源；解锁允许下次刷新覆盖。
- 改番号 / 解除番号锁时必须 `codeLocks:"keep"|"clear"`，清除旧来源关联，旧计划失效。
- 可用 `revertId` 代替 fields 恢复历史修订；仍需当前 revision 和 codeLocks。
- 版本冲突 `409 revision_changed`；运行中保存 `409 task_running`。保存不改名、不写媒体。

### 19.4 已撤回的问题中心

GET / POST /api/issues 返回 404，问题聚合与忽略接口已移除。旧 issue_ignores 表保留但不读取，新数据库不再创建该表。

### 19.5 候选分析

`POST /api/subtitles/analyze`，body `{file,candidate,startSec:0,fit:{mode:"none"}}`。

响应含 token、来源、语言、encoding、bytes、cues、firstSec/lastSec、coverage（片长未知为 null）、verdict、warnings/problems、fit、同一 60 秒窗口的 original/adjusted cue。不返回字幕 base64，不写媒体目录。

每份最大 8 MiB，分析超时 60 秒。候选对象必须来自当前文件上下文；分析 token 绑定同一记录修订/来源/指纹，选入计划时重新校验并检查一小时有效期。分析缓存下次分析时清理过期项。选入计划请求：
`POST /api/plans/:id {revision,candidateToken,file}`。主字幕仅接受通过校验的简中候选；其他语言可比较，仍沿用手动安装入口。选入后字幕字节保存在计划中，应用不重选主候选。

### 19.6 可读报告

`GET /api/jobs/:id/html?lang=zh-CN|en` → `text/html`。同一内容支持 GUI 内嵌、离线保存及打印；可选 theme=auto/light/dark 与 fontSize=12–20，GUI 自动传当前偏好。

报告区分预演与实际操作，按失败 / 写入 / 保留过滤；展示前后名称、字幕来源、封面、锁定、备份和完整路径。缺少的旧信息显示未记录，不从计划推断写入。CSP 禁止远程资源；原 JSON / 日志接口保留。

### 19.7 缓存与维护

GET /api/health 增加 instanceId（每次进程启动更新）、pid、restartSupported、maintenance（null/cache/restart）。

POST /api/maintenance/cache，body {} → {metadataEntries,previewFiles,coverEntries,entries,bytes}。仅删除 codes、subtitle-previews 中的 64 位十六进制 JSON 文件和封面代理内存缓存。bytes 为缓存内容估算字节数，非 SQLite 文件缩减量。保留所有人工修正、媒体、旁车、固定计划、历史与撤销。链接或异常缓存目录返回 409 unsafe_cache_directory。

POST /api/maintenance/restart，body {} → 202 {accepted:true,instanceId:<旧实例>}。响应完成后关闭当前工作进程，启动器仅重启自身子进程，保持端口 / host / config / cwd。浏览器轮询 health，新 instanceId 出现后 reload；30 秒内无恢复则显示手动重启提示。import 启动未注入 onRestart 回调时返回 503 restart_unavailable。

两个接口只接受同源 JSON 浏览器请求（无 Origin 的 CLI JSON 调用兼容）；其他来源为 403，非 JSON 为 415。运行任务、等待任务或其他在途 API 操作时返回 409 task_running；维护中请求其他 API 返回 409 maintenance_in_progress，health 仍可读。输入不接受任意路径、PID 或命令。

## 20. v0.8.0 超级拼装（增量接口）

所有路径沿用 `fs.allowedRoots` 授权，解析符号链接后的真实路径也必须允许。浏览器跨来源请求返回 403。封装开始接口忙时返回 409，不提供新的队列控制接口。

| 接口 | 请求 / 响应 |
|---|---|
| `GET /api/assembly/settings` | 返回 ffmpeg、ffprobe、endpoint、authHeader、timeoutMs、limit、proxy、hasSecret；不返回 secret |
| `POST /api/assembly/settings` | JSON 局部更新；secret 缺省保留、空字符串清除；保存成功返回公开设置 |
| `GET /api/assembly/capabilities` | 分别返回 ffmpeg / ffprobe 的 available 和版本首行；只检测工具，不访问搜索服务 |
| `POST /api/assembly/files` | `{dir}` → `{dir,files:[{file,name,size,subtitles,subtitle}]}`；本层最多 1000 个视频，同名 SRT 优先 |
| `POST /api/assembly/plan` | `{files:[{file,subtitle}],container:"mp4"|"mkv",language:"zho",title:"Chinese",makeDefault:false,outputDir:""}` → 固定计划，1–100 个文件 |
| `POST /api/assembly/start` | `{planId,keepExisting:false}` → 202 `{jobId,job}`；有其他字幕轨时必须 keepExisting=true |
| `POST /api/assembly/search` | 原始 PNG / JPEG / WebP 图片字节，Content-Type 为对应 image 类型，非 JSON / base64；最多 8,000,000 字节 |

计划含 id、createdAt、state、options、工具路径与 items。每项含 file、subtitle、output、status（ready / duplicate / blocked / error）、error、tracks、requiresConfirmation 等。已有相同字幕永不执行；已有其他轨需要明确保留确认。输入或输出占用变化返回 `SOURCE_CHANGED`、`SUBTITLE_CHANGED`、`OUTPUT_EXISTS` 等。计划 24 小时有效且只能执行一次。

封装任务 `kind:"mux"` 复用 `/api/jobs/:id`、events、cancel、log、report、html 与普通历史持久化。progress 包含 done、total、stage、file、percent；stage 为 prepare / mux / verify / hash / complete / cancelled，percent 是当前文件阶段进度。SSE 额外发送 `{type:"mux-progress",progress}`。取消等待子进程关闭及临时文件清理；部分成功输出保留。

报告含 kind、apply:true、journal、results（file/output/status/sha256 或 error/detail）、summary、cancelled。HTML 为媒体专用报告。`POST /api/undo` 识别数据目录根下 v2 `mux-create-output` 日志，返回原有 restored/removed/failed/restoredItems/reset 结构；媒体撤销不转移人工字段身份，不删除源文件。普通 typed/legacy 日志按 §6 的新安全契约处理。

搜索响应：`{results:[{code,similarity:98.7,timestamps:["02:01:28"]}]}`；最多 20 条。稳定错误包括 SEARCH_NOT_CONFIGURED、SEARCH_RATE_LIMITED（429）、SEARCH_ACCESS_DENIED、SEARCH_REDIRECT、SEARCH_TIMEOUT、SEARCH_NETWORK_ERROR、SEARCH_INVALID_RESPONSE、INVALID_IMAGE / INVALID_IMAGE_SIZE。无自动重试和重定向，客户端断开时取消上游连接；响应内容上限 2 MiB。

endpoint 默认空，仅允许 HTTPS 或本机 HTTP，无 URL 凭据 / 查询参数 / fragment；鉴权头仅允许 Authorization 或 X-*。Authorization 自动添加 Bearer 前缀。timeoutMs 3000–120000，limit 1–20；proxy 为可选 HTTP CONNECT 代理，仅适用于 HTTPS 目标。此上传传输独立于元数据 / 字幕 GET 的自动重试网络层。

设置文件与密钥不进入常规导出和诊断，图片与搜索结果不写磁盘。维护接口会拒绝在途分析 / 搜索 / 封装。数据备份增加 assembly/plans，继续包含普通 jobs 与 journal；不包含媒体输出和密钥设置。
