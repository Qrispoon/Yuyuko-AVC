# 模块接口契约 v1.0（冻结 / FROZEN）

> 冻结时间：2026-11-07。以下签名与返回结构**不得破坏性修改**。
> 变更规则：新增字段/可选参数 → 允许（次版本 +0.1）；改名字/删字段/改语义 → 禁止（需 v2 + 迁移说明）。

> v0.8.1（2026-11-11）统一收录此前视觉增量与 A01–A21 修复；文件副作用、旧日志撤销和整代恢复按本文 §21 执行。历史增量章节的签名继续可读，不能据旧文字重新启用无指纹删除、WAL 文件拼接或无日志覆盖。修复阶段证据保留当时版本，公开验证范围和平台限制见 [V081_RELIABILITY.md](V081_RELIABILITY.md)。

## 0. 约定

- 全部 ESM，零第三方依赖，Node ≥ 22.13.0（与 package engines 一致；本轮可用验证版本为 24.22.1 / 26.13.0）。
- 路径一律用绝对路径（除非标注 `name`）。
- 所有异步函数出错时 **throw Error**，并把稳定字符串放在 `err.code`（详见各模块）。
- 返回对象允许**新增**字段，调用方必须忽略未知字段。

## 1. `src/net/http.mjs`

```js
createHttp(config.network) -> {
  get(url, opts?) -> Promise<{status, headers, buffer, text, url, route, ms}>
  getFollow(url, opts?) -> Promise<同 get，自动跟 3xx，最多 5 跳>
  json(url, opts?) -> Promise<any>
  probe(url, timeoutMs?) -> Promise<{ok, status, ms, route, error}>
  routeFor(url) -> 'direct' | 'proxy'
  stats -> {requests, retries, fallbacks, errors, byRoute}
  jar -> cookie store
}
```
- `opts`: `{headers, timeoutMs, retry, route, method, body}`
- 只支持 https；路由策略：proxyHosts 命中 → proxy；directHosts 命中 → direct；否则 defaultRoute；失败自动换路由。
- 429/5xx 与网络错误自动重试（指数退避）。
- 稳定错误码：`TIMEOUT` `PROXY_CONNECT_ERR` `PROXY_REJECTED` `TLS_ERR` `NET_ERR` `EMPTY_RESPONSE` `ONLY_HTTPS_SUPPORTED`。

## 2. `src/core/code.mjs`

```js
extractCandidates(fileName) -> {
  stem: string, cleaned: string,
  notes: string[],                       // 'ad-domain' | 'quality-noise' | ...
  candidates: Array<{
    code: string,                        // 规范番号，如 'IPX-920'
    label: string, num: string, sub?: string,
    rule: 'std'|'fc2'|'heyzo'|'series',
    score: number,                       // 越大越可信
    known: boolean,                      // 命中已知厂牌表
    scope: 'censored'|'fc2'|'heyzo'|'series'|'unknown'
  }>
}
toLookupVariants(code) -> string[]       // ['IPX-920','IPX-0920','IPX920', ...]
isNormalizedName(baseName) -> boolean    // 是否已是 "<CODE> <title>" 形态
```
- 只针对**有码**场景做确认；`scope !== 'censored'` 由流程层判为 `out_of_scope`。
- 无候选返回空数组（不是 null）。

## 3. `src/core/template.mjs`

```js
buildNewName({code, titleJa?, titleZh?, actress?, releaseDate?, maker?, ext?, template?, maxLength?}) -> string
normalizeTitle(title, {code?, actress?}) -> string   // 去番号前缀、去尾部女优名
sanitizeFileName(name, maxLength?) -> string
cleanText(s) -> string
looksNormalized(baseName) -> boolean                 // 仅展示用；判定请用 isNormalizedName
```
- 模板占位符：`{code} {title} {actress} {date} {maker}`；无女优时 `[]` 整体省略。
- 只做 Windows 文件名清洗，不做路径拼接。

## 4. `src/core/rename.mjs`

```js
fingerprint(file) -> Promise<{size, mtimeMs, isFile}>   // 仅元数据，不读内容
planRenames(items, {dir?}) -> Promise<Array<{from, to, action, reason?}>>
        // action: 'rename' | 'skip_same' | 'skip_duplicate' | 'skip_conflict'
applyRenames(plan, {dataDir?, dryRun?, journalFile?}) -> Promise<{renamed, executed, skipped, journal}>
annotateJournal(journalFile, toPath, extra) -> Promise<boolean>
undoJournal(journalFile) -> Promise<{restored, restoredItems, removed, failed}>
journalPathFor(dataDir?) -> string
toLongPath(p) -> string
```
- 冲突策略：目标存在且**同尺寸** → `skip_duplicate`；不同尺寸 → 改名并加 ` (2)` 后缀。
- 新日志为 `type:file-operations,version:1`，含 operationId、文件证据、写前阶段及完成阶段；旁车路径字段只作兼容展示，撤销依据为事务内历史指纹与逐步状态。
- **一次运行共享一个 journal**（批量回滚依赖此约定）。

## 5. `src/core/state.mjs`

```js
openState(dbFile?) -> {
  getFile(path), upsertFile(path, patch), listFiles(), listByStatus(status),
  isProcessed(path, {size}), getCode(code), putCode(code, data),
  putSubtitle(rec), subtitlesFor(code), summary(), close()
}
```
- `upsertFile(path, patch)`：`patch.status` ∈ `discovered|ok|no_subtitle|unresolved|out_of_scope|no_code|error`；`patch` 其余字段可省略（合并更新）。
- `patch.data` 建议 `{size, meta, sub, renamedTo}`。
- 表结构见 `docs/ARCHITECTURE.md` / 源码建表语句；新增列需兼容读取旧库。

## 6. `src/sources/javbus.mjs`

```js
createJavbus(http) -> {
  search(code) -> Promise<string|null>        // 详情页绝对 URL；无结果 null
  detail(url) -> Promise<{
    code, titleJa, releaseDate, durationMin, maker, publisher,
    series, genres: string[], actress: string[], coverUrl, url
  }>
}
```
- 稳定错误码：`JAVBUS_PARSE_FAILED`（页面结构变更）。

## 7. `src/sources/manko.mjs`

```js
createManko(http) -> {
  search(code), detail(movieId), actors(movieId), subtitleLink(movieId),
  findByCode(code) -> Promise<null | {
    movieId, code, titleJa, titleZh, durationMin, rating, maker, releaseDate, coverUrl,
    actress: Array<{jp?, zh?, en?}>,
    subtitles: Array<{lang: 'ZH'|'TW'|'EN'|'KO'|'ID', url: string}>
  }>,
  download(url) -> Promise<{buffer, bytes, contentType}>
}
```
- `findByCode` 进程内缓存；主演取 `order` 最小者。
- 字幕语言键**原样返回**，`ZH`=简体，`TW`=繁体；不得推断文件名后缀。

## 8. `src/subs/source-manko.mjs`

```js
createMankoSubSource(manko) -> {
  name: 'manko',
  find(code) -> Promise<null | {source:'manko', lang:'zh', url, movieId}>,
  download(found) -> Promise<{buffer, bytes, contentType}>
}
```
- 只返回 `ZH`；没有 → `null`（不得返回繁体/英文）。

## 9. `src/subs/source-subtitlecat.mjs`

```js
createSubtitlecatSource(http) -> {
  name: 'subtitlecat',
  find(code) -> Promise<null | {source:'subtitlecat', lang:'zh', url, srtName, detailUrl}>,
  download(found) -> Promise<{buffer, bytes, contentType}>
}
```
- 只取文件名含 `-zh-CN` 的；必须做番号强校验（搜索是模糊的）。
- 网络错误 throw；确认无简体 → `null`。

## 10. `src/subs/verify.mjs` / `install.mjs`

```js
decodeToUtf8(buffer, opts?) -> {text, encoding, hadBom}
parseSrt(text) -> {cues: Array<{index,start,end,text}>, count, lastEndSec, problems: string[]}
classifyChinese(text) -> {simplifiedHits, traditionalHits, verdict: 'zh-CN'|'zh-TW'|'unknown'}
verifySubtitle({buffer, expectedDurationMin, lang, maxDurationDeltaMin?}) ->
    {ok, verdict, encoding, cues, lastEndSec, durationDeltaMin, warnings, reason, hadBom, problems}

subtitlePathFor(videoPath) -> string
installSubtitle(videoPath, buffer) -> {path, bytes}   // UTF-8 无 BOM + LF
```

## 11. `src/pipeline.mjs`

```js
listVideos(dir, config) -> Promise<Array<{path, name, size}>>
scanDirectory(dir, config) -> Promise<Array<{path,name,size,code,scope,score,normalized,candidates,notes}>>

createContext(config, {state, logger?, journalFile?}) -> ctx

processFile(ctx, file, {apply?, downloadSubs?}) -> Promise<{
  file, name, status, candidates: string[], code, meta: object|null,
  newName: string|null, sub: object|null, error: string|null, renamedTo?, journal?
}>

runDirectory({dir, config, apply?, limit?, force?, downloadSubs?, logger?, onEvent?,
              fileTimeoutMs?, maxConsecutiveFailures?, signal?, concurrency?})
  -> Promise<{
    dir, apply, count, summary: Record<status, number>, results: object[],
    http: object, journal: string|null, durationMs, aborted: string|null,
    cancelled: boolean, fileTimeoutMs, startedAt
  }>
```
- `onEvent` 事件：`start | file-start | file-done | file-error | file-skipped | done`。
- `summary` 的键是 `status`；`ok/no_subtitle/out_of_scope/no_code` 会跳过，`unresolved` 会重试。

## 12. `src/server.mjs`（HTTP 服务）

见 `docs/SERVICE_API.md`（同样冻结）。启动：`node src/server.mjs --port 17890 [--open]`，只绑定 `127.0.0.1`。

## 13. v1.1 增量契约（向后兼容）

### 13.1 字幕源统一接口

```js
createXxxSource(...) => {
  name: 'manko' | 'subtitlecat' | 'local',
  listCandidates(code) -> Promise<Array<{source, lang:'zh', name, url?, localPath?, sizeHint?}>>,
  download(candidate) -> Promise<{buffer, bytes, contentType?}>,
  find(code) -> Promise<candidate|null>   // 旧接口，保留兼容
}
```
- 流程层只取每源前 `subs.maxCandidatesPerSource`（默认 4）个候选
- 本地源 `createLocalSource({ dirs, maxDepth=2 })`：只读 .srt，按番号宽松匹配，目录不可读返回 []

### 13.2 时间轴校正 `src/subs/fit.mjs`

```js
parseSeconds(srt) -> {first,last,count}
shiftSrt(text, seconds) / scaleSrt(text, factor)
autoFitSrt(text, {videoDurationSec, mode:'auto'|'scale'|'shift'|'none', toleranceSec=2, maxShiftSec=90})
  -> { text, applied:'none'|'scale'|'shift', factor?, shiftSec?, reason? }
```
- `auto` 仅在字幕末条超出片长 > `toleranceSec` 时按比例缩放；否则不动（保守）
- 片长来源：元数据 `durationMin`；安装 ffmpeg 后可改用 ffprobe 实测（后续）

### 13.3 封面 `src/media/*`

```js
pickCoverUrl(meta) / isImage(buffer) / coverSidecarPath(video) / downloadCover(http,url) / writeCover(video,buffer,{alsoPoster})
detectFfmpeg() -> Promise<null|{ffmpeg,ffprobe,version}>   // 异步
probeDurationSec(video) / embedCover(video,image,{outPath,ffmpeg})
```
- 默认只写同名 `.jpg`（`covers.download`）；`covers.embed` 且 ffmpeg 可用时才写回视频文件
- 嵌入前后探测容器轨道、时长与封面，使用同目录独占临时产物；仅用户选定的当前媒体覆盖被允许。失败记录 `cover.embedError`；覆盖后身份调和未完成会保留待处理标记并阻止按路径创建新身份，不能视为全部成功。

### 13.4 流程结果新增字段

`result.sub` 增加 `candidates`（候选数）、`name`、`fit`；`result.cover = {path,posterPath,bytes,embedded?,method?,embedError?,embedSkipped?}`；dry-run 时可出现 `result.coverPlanned`。

### 13.5 subtitlecat 候选上限（v0.4.1）

- 配置项：`subs.subtitlecatLimit`（默认 4，范围 1–12）
- 字幕源接口扩展：`listCandidates(code, { limit })`；subtitlecat 在收集到 limit 个 zh-CN 候选后立即停止详情探测
- 流程层把该值传给 subtitlecat 源；其它源仍用 `maxCandidatesPerSource`
- UI：设置 → 字幕 → 「subtitlecat 候选上限」，越大越慢越全

### 13.6 并发与撤销一致性（v0.4.2）

- `applyRenames/annotateJournal` 对同一 journal 文件的写入已串行化（进程内互斥），并发 apply 不会丢条目
- journal 条目可含 `srt` / `cover` / `poster` 展示字段；只有新事务中未变更的输出才可隔离并恢复可信备份，用户后来修改的文件保留并返回冲突。
- 时间校正护栏：`autoFitSrt` 对"末条 > 片长×3"或"缩放系数 <0.5 或 >2"直接跳过

### 14. 手动番号与强匹配（v0.4.4）

- `POST /api/jobs` 的 `options.overrides`：`{ "<文件绝对路径>": "番号" }`，仅作用于本次任务；
  手动番号会持久化到状态库（`data.manualCode`），后续 apply 无需重复输入。
- `normalizeManualCode()` 保留前导零；`canonCode()` 用于比较（忽略分隔符与前导零）。
- `resolveMeta` 增加强匹配：`canonCode(meta.code) !== canonCode(requested)` 时跳过，绝不采用错片。

---

## 15. v1.2 增量契约（v0.6，向后兼容）

> 全部为**新增**导出/字段/可选参数；既有签名与语义不变（改语义的只有 §15.2 的跳过判定，已注明）。

### 15.1 `src/pipeline.mjs`

```js
configSignature(config) -> string          // 'v06-xxxxxxxx'，影响预演/应用结果的配置子集签名
shouldSkipFile({prev, fileSize, apply, force, planSig, hasOverride}) -> boolean  // 纯函数，无 IO
durationSecOf(meta) -> number|null         // 优先 meta.durationSec，回退 durationMin*60

processFile(ctx, file, {apply, downloadSubs, overrideCode, persist = true})
  // persist:false 时跳过所有 state.upsertFile 写操作（供 /api/preview 使用），读操作保留
  // 结果新增：rename = { from, to, action, reason?, batchConflict? }
  // 结果 meta 可能新增：durationSec / durationSource('probe'|'metadata'|'unknown') / warnings[]

scanDirectory(dir, config) -> items[]
  // item 新增：duplicates: string[]（同目录同 canonCode 的其它文件绝对路径）

runDirectory(...) -> report
  // report.results[] 的 rename 会带 batchConflict=true（dry-run 下同批目标重名）
```

**语义变更（唯一一处）**：`runDirectory` 的跳过判定由"非 apply 一律跳过已完成"改为
`shouldSkipFile`：dry-run 仅在 **configSignature 未变**时跳过；apply 仅在"已应用且签名未变"时跳过。
这样改模板后二次预演会重新计算，且应用结果与已确认的预览一致。旧状态库行没有 `planSig` → 会重新处理一次。

### 15.2 状态库 `data.*` 新增字段

`planSig`、`stage`（`plan`/`apply`）、`rename`。`core/state.mjs` 新增方法：

```js
resetFile(filePath)  // status='discovered'，清 code/new_name/sub_path/error/data
deleteFile(filePath) // 删除该路径的行（撤销后清理改名产生的 ghost 行）
```

### 15.3 `src/core/rename.mjs`

```js
backupPathFor(file) -> string          // '<file>.avc-bak-<epochMs>'
backupFile(file) -> Promise<string|null> // 文件存在则改名到备份路径，返回备份路径；不存在 null
originalPathOfBackup(backup) -> string|null

undoJournal(journalFile) -> { restored, restoredItems, removed, restoredExtras, failed }
```
- journal 条目新增可选字段：`srtBackup` / `coverBackup` / `posterBackup`（覆盖前自动备份的旁车）。
- 撤销顺序：先恢复可验证的视频路径，再逐个隔离本次未变更的旁车、恢复可信备份并持久记录。失败保留已完成阶段；重复撤销按阶段继续，不能删除后来的用户文件。新返回字段及部分状态投影见 §21。

### 15.4 配置新增

`config.media.probeDuration`：`"auto"`（默认，检测到 ffprobe 才用）| `"off"`。
开启后 `meta.durationSec` 来自 ffprobe 实测；实测与原（元数据）时长相差 > 5 分钟时 `meta.warnings` 增加
`duration_mismatch`。ffprobe 不存在/失败/超时一律降级为原逻辑，不影响主流程。

### 15.5 服务端

`/api/diagnose`、`/api/preview`、任务历史持久化、终态 SSE 补发 `job-finished`、`publicJob.progress`、
撤销后状态库重置等，见 `docs/SERVICE_API.md` §11–§13。

---

## 16. v1.3 增量契约（v0.7，向后兼容）

> 全部为新增模块/导出/字段/可选参数；既有签名与语义不变。

### 16.1 元数据源 `src/sources/r18.mjs`（新）

```js
createR18(http) -> {
  name: 'r18',
  endpointFor(code) -> string,   // https://r18.dev/videos/vod/movies/detail/-/id=<contentId>/json
  findByCode(code) -> Promise<null | {
    code, titleJa, titleZh: null, releaseDate, durationMin, maker, publisher,
    series, genres: string[], actress: string[], coverUrl, url, source: 'r18'
  }>,
}
contentIdsFor(code) -> string[]   // ['ipx00920','ipx920','ipx-920']（按优先级）
parseR18Record(json, {url}) -> meta | null
```

- 字段解析必须兼容文档中的多种键名（`dvd_id`/`content_id`、`runtime_minutes`/`runtime`、`maker_name`/`maker`、
  `genres`/`actresses` 的字符串与 `{name}` 两种形状、`images.jacket_image.large_url` 等）。
- 404/非 JSON/缺番号字段 → `null`；传输错误 `R18_HTTP`；坏 JSON `R18_PARSE`。
- `pipeline.createContext` 增加 `r18` 与 `lookup`；`resolveMeta` 顺序为 **javbus → r18 → manko**，
  仅当 `canonCode(rec.code) === canonCode(请求番号)` 时采用；`config.metadata.r18 === false` 可关闭 r18。
  `configSignature` 已包含 `metadata.r18`（改开关会让旧预演失效重算）。
- v0.7.2：r18 请求直连失败且 `network.proxy` 已配置时，自动改用 proxy 路由重试一次（r18.dev 常需代理）。

### 16.2 反查 `src/sources/lookup.mjs`（新）

```js
createLookup({ http, config }) -> {
  byKeyword(keyword, { limit = 10 } = {}) -> Promise<Array<{
    code, movieId, title, releaseDate, maker, coverUrl, source: 'javbus'|'manko'
  }>>,
}
mapLookupRecord(record) -> candidate | null   // manko 记录映射（纯函数）
mapJavbusItem(item) -> candidate | null       // javbus 搜索项映射（纯函数）
```

- 后端顺序（v0.7.2 修正）：javbus `searchKeyword(keyword)`（`src/sources/javbus.mjs` 新增，支持演员名/标题片段）
  → 失败或 0 结果时回退 manko（manko 搜索实际只匹配番号）。
- `canonCode` 去重；输入是番号时精确匹配优先，其余按发行日期倒序。

### 16.3 多语言附加字幕（F17）

```js
// src/subs/source-manko.mjs
createMankoSubSource(manko).findLang(code, lang) -> Promise<null | {source:'manko', lang, url, movieId}>
//   lang ∈ 'zh-TW' | 'en' | 'ko'（映射 manko 的 TW/EN/KO）

// src/subs/install.mjs
subtitlePathForLang(videoPath, lang) -> string       // '<stem>.<lang>.srt'
installSubtitleAs(videoPath, buffer, lang) -> { path, bytes }
```

- `config.subs.extraLangs: string[]`（默认空）仅在 **apply** 且主简体字幕成功后处理；
  结果 `result.extraSubs = [{ lang, path, bytes, cues, warnings }]`。
- journal 保留 `srtExtra: [{lang,path}]`、`srtExtraBackup: [{lang,path,backup}]` 兼容展示；额外语言也必须经过最终字幕校验与类型化旁车事务，撤销按指纹隔离/恢复，不根据路径数组直接删除。
- 不改变"没有简体 → `no_subtitle`"的判定。

### 16.4 服务端可导入与 VERSION

```js
// src/server.mjs
export const VERSION;                      // 从 package.json 读取（单一来源）
export async function startServer(opts = {}) -> Promise<{ server, port, close() }>
//   opts: { port, host, configFile, quiet }
//   - 同一进程内可多次 start/close（会重置模块运行态）
//   - 文件末尾 main-guard：直接 `node src/server.mjs` 时行为与旧版一致
```

### 16.5 状态库迁移与备份（F22）

```js
// src/core/state.mjs
openState(dbFile) -> { ...既有方法, schemaVersion() }
```

- `PRAGMA busy_timeout = 5000`；当前 `SCHEMA_VERSION = 3`。迁移前非空库先以 `VACUUM INTO` 生成 `<dataDir>/backups/state-v<old>-<ts>-<uuid>.db` 一致快照；失败阻断迁移。旧库补建幂等撤销投影回执表，不改变人工字段修订。
- journal 必须同时按 type/version 分派：无 type 的缺版本或 v1 为只读 legacy；`file-operations/v1` 为新普通事务；`mux-create-output/v2` 为独立成片撤销；其他格式拒绝。

### 16.6 CLI 新增命令

```js
// src/cli.mjs
export async function main(argv) -> number   // process.exitCode 兼容；文件末尾 main-guard

avc backup [dest]      // 一致 state.db 快照 + journal/run/jobs/plans/assembly + hash manifest
avc restore <dir>      // 已有任一数据库 tuple 时默认整体跳过；--force 切换整代且保留旧代
avc restore --recover  // 验证/回滚明确的中断恢复；不需要备份目录参数
```

### 16.7 发布工具（F18/F21）

```js
// tools/check-release.mjs   零依赖；5 项检查（版本一致/占位符/引用路径/CHANGELOG 标题/无硬编码版本），失败 exit 1
// tools/build-docs-zip.mjs  -> dist/AVC-v<version>-交付文档.zip
// tools/lib/zip.mjs         零依赖 ZIP 写入器（store + 可选 deflate）
// tools/build-portable.mjs  白名单打包 + 完整 node LICENSE + VERSION.json（含文件清单与 sha256）
```

### 16.8 测试基建

```js
// tests/helpers/factory.mjs
makeJavbusSearchHtml / makeJavbusDetailHtml / makeMankoSearchJson / makeMankoDetailJson /
makeMankoActorsJson / makeMankoSubtitleJson / makeSubtitlecatSearchHtml / makeSubtitlecatDetailHtml /
makeR18Json / makeSrt / ensureFixtures(dir?) -> Promise<dir>
```

`tests/sources.test.mjs`、`tests/subs.test.mjs`、`tests/subs-multi.test.mjs` 不再依赖真实 `fixtures/`：
真实目录存在时优先使用，否则用 factory 在临时目录生成，CI 无夹具时解析类用例也会执行。

---

## 17. v1.3.1 增量契约（v0.7.1，向后兼容）

### 17.1 手动字幕 `src/subs/manual.mjs`（新）

```js
createSubtitleSources({ config, http }) -> Array<source>   // 按 config.subs.sources 顺序
createSubtitleCatalog({ config, http }) -> {
  sources,
  list(code, { limit = 12 }) -> Promise<Array<{ source, lang, name, url, localPath, sizeHint }>>,
  installChosen({ file, candidate, durationSec?, journal?, fit? }) -> Promise<{
    path, bytes, cues, verdict, lang, warnings, backup, journal, fit
  }>,
}
normalizeSubtitleLang(lang) -> 'zh' | 'zh-TW' | 'en' | 'ko'
normalizeCandidate(candidate, sourceName) -> candidate|null
```

- `list()` 只列出候选（不下载）；单个源抛错时跳过，不影响其他源。
- `installChosen()`：`SUBTITLE_REJECTED`（`reason: empty|not_srt|download_failed`）、`CANDIDATE_REQUIRED`、
  `SUBTITLE_SOURCE_UNAVAILABLE`；非 `zh` 语言写 `<stem>.<lang>.srt`，并给 `warnings` 加 `non_zh_lang:<lang>`。
- `journal` 参数为 `{ file, toPath }`：写入 `srt` / `srtBackup`（简中）或合并 `srtExtra` / `srtExtraBackup`（其他语言）。

### 17.2 服务端

`POST /api/subtitles/candidates`、`POST /api/subtitles/apply`、`POST /api/cover/fetch`，
见 `docs/SERVICE_API.md §17`；三者运行中返回 `409 task_running`，且都不创建任务。

### 17.3 状态库字段

`/api/scan` item 与状态库 `data` 新增 `coverPlanned`（预演阶段的封面下载计划，便于界面区分"将下载/待下载/失败"）。

---

## 18. v1.3.2 增量契约（v0.7.2，向后兼容）

### 18.1 备份模块 `src/core/backup.mjs`（新）

```js
createBackup({ dataDir, destRoot?, name? }) -> Promise<{ path, files }>
restoreBackup({ backupDir?, dataDir, force?, recover? }) -> Promise<{ copied, skipped, retained? } | { recovered, committed?, reason?, retained? }>
listBackups(dataDir) -> Promise<Array<{ dir, name, files, createdAt }>>
listFilesRelative(dir) -> Promise<string[]>   // 递归相对路径，正斜杠
uniquePath(base) -> string
```

- 稳定错误码：`DATA_DIR_NOT_FOUND`、`BACKUP_DIR_NOT_FOUND`、`INVALID_BACKUP`（备份目录缺 `state.db`）。
- CLI `backup` / `restore` 与服务端 §18 API 共用该模块；一致快照、整体跳过/切换、恢复意图和回执见 §21，不再逐文件混入历史。

### 18.2 服务端

`POST /api/backup`、`GET /api/backups`、`POST /api/restore`、`GET /api/subtitle/preview`，
见 `docs/SERVICE_API.md §18`。均为只读/数据维护类接口；备份与恢复在任务运行中返回 `409 task_running`。



## 19. v1.4 增量契约（v0.7.5，向后兼容）

### 19.1 操作计划 `src/core/workflow.mjs`

```js
workflowOptions(input?) -> {mode,metadata,subtitles,covers,extraSubtitles,rename}
effectiveMetadata(source,previous,fields,missing?) -> metadata
diskAssets(file,durationSec?) -> Promise<{subtitles,cover}>
createOperationPlan(report,config,state,options?) -> Promise<plan>
savePlan(config,plan) -> Promise<plan>
loadPlan(config,id) -> Promise<plan>
resolveConflicts(plan,decisions) -> Promise<plan>
validatePlan(plan,state) -> Promise<true>
reportHTML(report,{english?}?) -> string
```

- plan v1 包含 UUID、revision、创建时间、目录、config/options 快照、entries 和 state（preview/executing/consumed）。
- entry 包含文件记录 ID、人工修订、stat 指纹、旁车/目标快照、最终结果和用户决定。私有主字幕缓存只存在应用数据文件，不能透传普通 API/report/SSE。
- validatePlan 抛 `code:"NEEDS_REVIEW"`，附 reasons；应用每个文件前再次校验。不静默改变已确认名称。
- 缺项模式只填空元数据、保留锁定和有效旁车，默认不改名、不嵌入封面。显式改名时复制有效旁车到新名并记入撤销，原旁车保留。
- 附加语言继承既有“应用时才查询”规则；配置和目标路径固定，报告只记录实际取得的内容。

### 19.2 人工修正与 schema v3

openState 新增：

```js
record(path) -> {id,path,source_id,revision,fields}
correct(path,fields,revision) -> record
correctionHistory(path) -> Array<{id,record_id,revision,fields,at}>
moveRecord(from,to)
clearCodeCache() -> {entries,bytes}
```

schema 2 → 3 迁移沿用备份机制，新增 records/corrections/issue_ignores。文件身份不按番号或大小合并；同路径出现不同文件时旧修正归档。仅程序改名/撤销明确转移身份。correct 乐观并发，错误 revision_changed；字段独立于 resetFile 和媒体撤销。

fields 为 `{[key]:{value,locked}}`；可锁定空字符串。actress 是字符串数组；其他允许字段是字符串，日期/URL校验见 API §19。

### 19.3 管线增量

processFile 新增可选 `confirmed / workflow`；runDirectory 新增可选 `operationPlan / workflow`。旧参数、状态与返回字段保留。result 新增 `originalFile,sourceMeta,actions,backups,locks`；主字幕私有缓存不属于公共返回契约。actions 记录实际完成/保留/禁用/缺源或预演计划，不能把 planned 解读为写入成功。

### 19.4 撤销日志仍为 v1

新增 `ensureJournalEntry(journalFile,file)` 创建 from=to 且 sidecarOnly=true 条目。仅写字幕/封面无需伪造视频改名；撤销该条目保持视频不动，按可信指纹隔离旁车并恢复备份。无 type 的旧 journal v1 可读但默认 `legacy_unverifiable`，不自动动文件。人工字段修正不会被媒体撤销回滚。

applyRenames 在执行改名前再次检查目标占用，拒绝覆盖（NEEDS_REVIEW）。本版没有视频流重写；v0.8 嵌入字幕须独立设计 journal v2。

### 19.5 候选分析与任务维护

createSubtitleCatalog 新增 `analyze({candidate,durationSec?,fit?,startSec?,windowSec?})`。原始/校正后使用同一时间窗；coverage 未知为 null。返回 base64 供内部缓存，服务端向浏览器剔除此字段。单源失败不阻塞另一个候选展示。

失效计划进入 needs_review，要求重新预演；中断任务恢复为 aborted 并保留 partial 结果，不自动续跑。撤回队列快照、暂停 / 排序 / 复核重入队、问题聚合和忽略接口。普通 FIFO 执行与任务历史保留。

clearCaches(dataDir,covers?) 只清理应用生成的查询 / 分析 / 代理缓存，保留计划、历史、人工修正和媒体。startServer(opts) 可注入 onRestart 回调，默认外部托管不启用重启；CLI 使用 gui-supervisor 管理自身子进程，工作进程在响应完成、关闭监听后以退出码 75 请求重启。API 见 SERVICE_API §19.7。

## 20. v0.8.0 媒体工具增量

不改变 journal v1 与旧管线签名。`src/core/assembly.mjs` 独立提供：

```js
discover(dir, allowedPath) -> {dir, files}
createMuxPlan(dataDir, body, settings, allowedPath, signal?) -> plan
claimMuxPlan(dataDir, id, {keepExisting?}, allowedPath) -> plan
executeMux(dataDir, plan, {signal?,allowed,onProgress?,onResult?,jobId?}) -> report
undoMux(journalFile) -> {removed,restored:0,failed,restoredItems:[]}
```

封装计划输入为显式 files 数组，不扩大选择范围；分析只读取本地视频和 SRT，不调用网络字幕源。源文件身份、字幕字节 hash 与输出占用在执行前和发布前重新校验。仅发布校验成功的独立输出，源媒体和旁车不改名、不删除。

v2 `mux-create-output` journal.items 记录 output/source/sha256/size/phase 和可用的 identity。phase 为 publishing / published / undone。输出未改动才允许撤销；撤销只删除成片，不重置或转移源媒体人工字段。GUI/CLI 按 type/version 分派，`rename.undoJournal` 只处理普通类型，并拒绝误派的 mux 日志。

## 21. 2026-11-11 文件与服务安全修订

- 普通媒体移动、旁车备份和恢复采用本地同卷普通文件的排他 link 发布与清源，不覆盖已有目标；不支持跨卷/网络盘的自动降级。正常成功清除源路径；中断双路径仅在身份一致时调和。源文件在操作期间须由合作方独占；不承诺抵御不合作进程在检查和 unlink 之间替换源路径。
- JSON 意图在副作用前以独占临时文件、文件 sync 和原子替换保存；同一日志串行更新。此为文件级持久化协议，没有经过断电试验，也不承诺所有平台的目录 fsync/掉电持久性。
- `writeJournalSidecar` 保存输出摘要、已有内容及备份证据；`undoJournal` 返回 `undoComplete / completedItems / videoDoneItems / retainedEffects`。`restored` 是本次完成的视频路径数，不能代表旁车和数据库全部完成。用户改动返回 `failed`，文件保留。
- CLI/API 共用 `undoAndProject`。每个已持久化的 `videoDone` 都独立投影 records 路径、保留 fields/corrections，并重置已有 files 应用状态、移除原目标幽灵行；旁车冲突不阻止路径投影。`undo_projections` 的 operationId 回执防止重复撤销清除后来工作。投影失败返回 `stateError` 和 `undoComplete:false`，再次执行可重试。
- 封面嵌入覆盖当前媒体且不保存原媒体版本。`.identity-pending-*` 绑定旧记录与已验证产物，可信内部替换迁移同 record/source_id；外部同路径替换创建新记录。待调和时阻止备份/恢复和按路径创建记录。撤销恢复路径后仍保留嵌入字节，`retainedEffects:["embedded_cover"]` 必须在部分撤销时也可见。
- 备份使用 `VACUUM INTO` 产生独立 state.db，不复制 WAL/SHM；hash manifest 绑定 journal/run/jobs/plans/assembly。默认发现目标任一数据库 tuple 就整体跳过。force 要求没有已登记连接，阶段目录保存旧代，恢复 intent 存在时禁止 openState。显式 recover 验证新旧摘要并回滚或确认已提交代，保留旧代和新产物；不自动清除未知外部所有者。
- 数据目录变更共享可重入所有权及排他协作 lease；未知旧 lease 不自动偷取。超时先 abort，再等待拥有的请求/进程/写操作结束。服务 close 返回同一 Promise，拒绝新写、等待请求和任务、报告、快照、日志后结束；启动器经 IPC 等待自身 worker 收敛。
- API 以实际 listener 的 Host/Origin 和精确 JSON/image 路由类型校验。启动器先校验公共端口，再将已验证 Host/Origin 转为内部 worker 地址；不反射外来 authority。普通无 Origin 的本地 JSON 客户端兼容。相关拒绝验证仅使用内存 fake 请求，未做真实跨源实验。
- 授权读取器规范化根/目标，拒绝已观察到的链接组件，打开后核对句柄身份并从同一句柄有界读取。现有 Node 接口不提供最终句柄路径证明；合同依赖祖先目录稳定，不声称解决恶意祖先交换。真实链接绕过实验未执行。
- 固定计划绑定 dir、实际集合、only、overrides、force、downloadSubs、workflow 及配置/文件修订。变化在消费计划前返回 needs_review。候选 token 绑定文件、记录修订、来源和指纹，过期/错文件/改候选拒绝；界面重绘、关闭和改番号清除旧候选，迟到结果丢弃。
- HTTP parser 只在完整 framing 后返回成功；截断、CL/TE 歧义、非法 chunk/trailer、超预算均失败。每次连接拥有 raw/TLS/socket/timer/listener，失败先清理并等待关闭才重试；此处只以纯内存 parser 和 fake socket/clock 验证。
- 时间轴按整数总毫秒转换，进位完整，只替换 cue 时间轴行，正文时间戳不修改。所有语言的最终结构/时序在备份和写入前校验。subtitlecat 搜索行和每个下载文件名都要求完整番号 token 等价。
- 任务快照入队前复制，按文件序列保存；报告和终态快照在数据目录写入锁内保存，释放 lease 后才同时公开终态/SSE 和空闲状态。保存或释放 lease 失败保持未完成且错误可见；执行已结束但仍在收尾时，迟到的取消请求不再覆盖已保存的终态。`close()` 共用保存屏障并拒绝后续写入。

`src/net/upload.mjs` 的 upload 是单次有界 POST，不复用会重试 / 跟随跳转的 GET 网络层。`src/sources/frame-search.mjs` 的 searchFrame 接收原始图片字节及私有配置，返回 `{results:[{code,similarity,timestamps}]}`；结果无缩略图 / 远程 HTML。公开设置不返回 secret，截图与结果不持久化。接口详见 SERVICE_API §20。
