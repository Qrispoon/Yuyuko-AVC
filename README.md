# AVC 补全器（avc）

大家好这里幽幽子。因为片很多所以就写了个这个。本项目AI代码含量100%，观前请注意。

> 把本地视频目录里的文件，自动 **识别编号 → 补全元数据（标题 / 演员 / 日期 / 时长 / 封面）→ 按模板改名 → 下载简体中文字幕**。
> 把本地字幕嵌入视频
>通过avscan的搜索api实现通过截图反查番号

当前源码版本：**v0.8.1**（2026-11-11）。
**0.8.1 更新重点**：可选的 **“更多动效（实验中）”** 默认关闭，修复了一些稳定性bug。

[![tests](https://github.com/Qrispoon/Yuyuko-AVC/actions/workflows/test.yml/badge.svg)](https://github.com/Qrispoon/Yuyuko-AVC/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/Qrispoon/Yuyuko-AVC)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](package.json)

\---

## ⚠️ 使用前必读

* **本项目仅用于整理你已合法拥有、且有权处理的本地媒体文件。** 不提供或下载影片；视频封装在本地完成。图片反查仅在用户主动点击搜索后，把所选截图发送到配置的服务。
* 不提供账号、片源、会员或代下载服务；不绕过付费墙或 DRM。
* 元数据来自第三方公开站点，版权归原权利人；本项目与其无关联，不对其可用性负责。
* 使用者应自行遵守所在地法律与目标站点条款；因使用产生的后果由使用者承担。
* 内容可能涉及成人向作品，**未满 18 岁请勿使用**。
* 工具不收集遥测，不上传本地文件列表（详见「数据与隐私」）。

## 功能

* **识别**：从文件名提取作品编号，自动剔除站点水印、分辨率、字幕标记等噪声
* **补全**：标题、演员、日期、时长、封面；多来源自动选优（javbus → r18.dev → manko）
* **改名**：模板可配置（默认 `{code} {title} \[{actress}]`），冲突检测
* **字幕**：多候选自动选优 + 时间轴校正（auto / scale / shift / none）+ 本地字幕目录；可附加繁体/英文/韩文字幕
* **反查**：文件名没有番号时，用标题/演员名/截图反查候选番号
* **超级拼装**：本地 SRT → MP4 / MKV 软字幕封装、重复轨检测、独立输出与可撤销历史；截图反查与番号复制。
* **大列表**：搜索、状态筛选、排序、按状态批量勾选；1000+ 文件增量更新不卡顿
* **界面体验**：Astra写的唐比gui，有一种表弟学了三年建模回家非要露一手的美。不过幽幽子好看就完了。
* **外观与语言**：设置页可即时切换简体中文 / English；全局字体支持 12–20 px 与快捷字号，自动保存在当前浏览器
* **v0.8.1 更多动效（实验中）**：烟紫玻璃界面
* **备份与恢复**：状态库升级自动备份；`avc backup` / `avc restore` 一条命令搬家
* **逐项勾选**：每条记录都能勾选/取消，只有勾选的文件参与预演与应用（支持全选、反选、全不选）。支持只补缺项、字段修正与锁定、字幕候选对比、冲突解决、可读历史报告、缓存清理与一键重启
* **变更预览**：预演后按状态汇总（将改名 / 无中字 / 未确认 / 目标冲突 / 重复番号），逐条可核对再应用
* **单文件预演**：详情抽屉里改番号、选候选、「仅重跑此文件」，不必整批重来
* **体检诊断**：设置页「运行自检」检查代理/网络/ffmpeg/数据目录，失败给可操作建议
* **可恢复**：任务历史重启不丢（可查看日志、任务级撤销）；本轮可强制重跑、限制条数、关闭字幕下载
* **安全**：默认 dry-run；应用后生成类型化 journal，可恢复文件名和有恢复依据的字幕/封面旁车，覆盖旁车前自动备份。封面嵌入会覆盖当前媒体且不保存原媒体版本；撤销后嵌入封面继续保留，不能恢复嵌入前的视频内容。缺少历史指纹的旧日志仅供复核，不自动移动或删除文件。
* **零依赖**：只用 Node 内置模块（SQLite 用 `node:sqlite`），无需 npm install



## 安装

### 方式一：Release 便携包（推荐）

1. 在 [Releases](https://github.com/Qrispoon/Yuyuko-AVC/releases) 下载 `AVC-vX.Y.Z-win64-portable.zip`
2. 解压到任意目录（路径可含空格/中文）
3. 双击 `start-gui.cmd`，浏览器会打开 `http://127.0.0.1:17890/`

### 方式二：源码运行

```powershell
git clone https://github.com/Qrispoon/Yuyuko-AVC.git
cd Yuyuko-AVC
# 需要 Node.js >= 22.13（推荐 24 LTS / 26）
node --version
node src/server.mjs --port 17890
```

## 快速开始

1. 把元数据源/代理等配置复制为本地配置：`copy config.example.json config.local.json`，按需修改
2. 打开界面 → 选择视频目录 → **扫描**
3. **开始预演**，检查「新名 / 封面 / 字幕来源」
4. 确认无误后 **应用改名**；可在「历史与撤销」恢复文件名和有恢复依据的旁车。存在冲突时保留文件并提示复核；嵌入封面继续保留

命令行等价用法：

```powershell
node src/cli.mjs doctor              # 检查网络与配置
node src/cli.mjs scan  "D:\\Videos"   # 只识别编号，不联网
node src/cli.mjs run   "D:\\Videos"   # 预演（默认不写磁盘）
node src/cli.mjs run   "D:\\Videos" --apply   # 真正改名并落字幕
node src/cli.mjs undo  data\\journal-XXXXXXXX.json
node src/cli.mjs backup D:\\Backup\\avc     # 备份状态库/journal/任务历史
node src/cli.mjs restore D:\\Backup\\avc\\avc-backup-YYYYMMDD-HHMMSS --force
```

## 配置（给AI读吧）

### 超级拼装（v0.8.0）

顶部“超级拼装”→“工具与接口设置”中指定 FFmpeg / FFprobe 路径。选择视频目录与本地 SRT，分析后确认嵌入，输出独立的 `.softsub.mp4` / `.softsub.mkv`；源视频不变，已有输出不覆盖，成功结果可在历史页撤销。缺少字幕请先在工作台下载。

图片反查接口默认未配置。可使用 `https://avscan.cc/search` 或兼容服务，按需设置鉴权与代理；选择截图后点击搜索才上传，只提供结果与番号复制。无需克隆上游项目或安装 Python。详细步骤和兼容限制见 [超级拼装使用说明](docs/V080_SUPER_ASSEMBLY.md)。

### 工作流升级（v0.7.5）

工作台“本轮选项”提供只补缺项；详情“修正与锁定”保存人工字段，字幕候选可双栏对比后选入固定计划。有命名冲突时在预演汇总显示处理入口；历史页可查看并导出离线 HTML 报告。右侧工作面板独立滚动、隐藏滚动条，底部应用操作保持可见。

应用前会校验源文件、人工修订和目标占用，过期任务要求重新预演。仅下载字幕或封面也能撤销。待处理中心、新增队列面板及其专用后端接口已撤回；统一勾选后直接预演。目录配置档明确废案。完整操作见 [v0.7.5 工作流说明](docs/V075_WORKFLOWS.md)，新增媒体工具见 [v0.8.0 使用说明](docs/V080_SUPER_ASSEMBLY.md)。

### 缓存与维护

设置 → 缓存与维护提供“删除缓存”和“一键重启前后端”。清理范围为元数据查询缓存、字幕对比临时文件和内存中的封面代理缓存；不会删除媒体旁车、人工修正、任务历史、撤销日志、固定计划、配置或浏览器壁纸。清理后当前页面预演会失效，需重新预演。显示的是缓存内容字节数，SQLite 文件不会因此立即缩小。

重启会更换后端服务进程，保持端口、配置与工作目录；页面检测到新实例后自动刷新。运行中、存在等待任务或其他接口操作尚未结束时拒绝维护，避免打断写盘。请先保存未保存的设置。通过原启动脚本或命令启动均支持；由其他程序 import 的后端默认禁用重启。

### 更多动效（v0.8.1，实验中）

点击顶部 **“更多动效（实验中）”** 开启，再次点击返回简洁模式。首次默认关闭，此后记住当前浏览器的手动选择；更新源码后，已打开的页面需要刷新一次。

* 使用统一烟紫配色，不再区分昼夜；开启后隐藏“主题”按钮和左下角自定义外观入口。原有壁纸、材质、樱花与时间联动暂时挂起，退出时恢复保存的偏好。
* 四个主页面分别使用用户提供的本地原画。底图保持静止，叠加少量花瓣、光尘、蝶形光影或微光；历史页对近方形原图做宽屏边缘融合。
* 顶部导航采用玻璃材质与移动选中胶囊，模式与背景平滑切换。保留原有主要布局、控件结构和业务流程。
* 只播放当前页氛围；失焦或隐藏时暂停。系统开启“减少动态效果”时保留静态背景与材质。
* 模式偏好仅存于浏览器，不进入后端配置或备份。切换模式不重建工作台，不清空输入、选中项或正在执行的任务。

四张原图未重绘或放大；1100–1200 像素宽的源素材在大屏下会受到清晰度限制。实现、截图位置和实测范围见 [更多动效说明](docs/MORE_EFFECTS.md)。此前独立场景 Demo 保留，本轮未接入动态场景。

### 简洁模式的外观与氛围（v0.7.4 起）

打开页面会显示「更新日志」，按版本从新到旧逐版列出日期及「新增 / 优化 / 修复」摘要，覆盖 v0.8.1 至 v0.1.0；0.8.1 同时收录更多动效和本次可靠性修复，并提示撤销边界。内容超出卡片高度时可用滚轮向下浏览，标题与底部操作保持固定。勾选「此版本不再自动提示」后，当前浏览器在同版本下不再弹出；升级到 0.8.1 后会提示新版本。点击顶部版本号或设置页的「更新日志」可随时重看，也可取消勾选恢复启动提示。提示偏好仅保存在当前浏览器。

在简洁模式下，点击页面左下角图片按钮，先打开**快捷小菜单**：一键切换清透 / 柔雾 / 静谧，更换图片、只看壁纸，以及开关飘落樱花与跟随现实时间。再次点击图片按钮、点击菜单外部或按 Esc 可收起。

进入顶部「设置」页的**外观与语言**，可选择简体中文 / English，并以 12–20 px 调整整个界面字号；列表、菜单与弹窗同步适配，偏好即时保存到当前浏览器。工作台、状态、设置、详情、外观面板和完整更新日志都提供英文界面，个人文件名与媒体元数据仍显示原文。

需要精细调整时，点击小菜单底部的\*\*「更多设置」\*\*，再打开「背景 / 面板 / 樱花 / 时间」四页完整面板：

* **背景**：本地图片或 URL、收藏与轮换、拖动取景、滤镜、亮度、饱和度、模糊和暗角；「只看壁纸」按 Esc 返回。
* **面板**：清晰 / 微透 / 磨砂材质，以及不透明度与模糊强度。
* **樱花**：数量、大小、速度、左右风力、透明度与景深；可关闭角落樱花枝。页面进入后台或失焦时暂停，系统减少动态效果开启时停用花瓣。
* **时间**：跟随电脑本地时间改变氛围（05:00 晨光、09:00 日间、16:00 暮色、20:00 夜间，色温和亮度在时段间平滑过渡），也可固定时段或关闭。夜间深色联动需单独勾选，且只在顶部主题为「自动」时生效。

清透 / 柔雾 / 静谧可一键应用。设置实时预览、自动保存，恢复默认不会删除壁纸收藏。外观偏好和图片保存在当前浏览器中，不进入 `config.local.json` 或后端备份；更换浏览器、访问端口或清理站点数据后需重新设置。本地图片不会上传，URL 壁纸会由浏览器访问对应地址。时间氛围无需联网或定位。

**樱花雨彩蛋**：连续轻点左上角头像三次，或在「更多设置 → 樱花」点击「下一场樱花雨」，播放约 8 秒的花雨与轻微枝头摇曳，不改变原有天气设置。花雨不会叠加，失焦或进入后台会结束；系统开启减少动态效果时不播放。樱花枝为随包提供的本地 SVG，无需联网。

### 业务配置

见 [`config.example.json`](config.example.json)。常用项：

|项|说明|
|-|-|
|`network.proxy`|代理地址（为空则直连），如 `http://127.0.0.1:7890`|
|`rename.template`|命名模板，支持 `{code}` `{title}` `{actress}`|
|`subs.sources`|字幕源顺序（本地目录 / 在线源）|
|`subs.fit.mode`|时间轴校正模式|
|`covers.\*`|封面下载、poster、嵌入视频（嵌入需 ffmpeg）|

> 程序会把界面里的设置写回 `config.local.json`（已在 `.gitignore` 中），仓库只保留模板。

## 状态说明

`ok` 已完成 · `no\_subtitle` 无简体字幕 · `unresolved` 编号未确认 · `out\_of\_scope` 不处理的类别 · `no\_code` 未识别 · `error` 失败

## 常见问题

* **扫描不到文件**：确认扩展名在 `scan.videoExtensions` 里、目录有读权限。
* **查不到元数据 / 字幕**：多为网络或代理问题；先跑 `node src/cli.mjs doctor`。第三方站点改版也会导致解析失败，欢迎提 Issue（附日志）。
* **改名后想恢复**：用「历史与撤销」，或 `node src/cli.mjs undo <journal.json>`。
* **没有 FFmpeg / FFprobe**：视频封面嵌入、可选时长探测和超级拼装的软字幕封装／校验需要相应工具；常规编号识别、元数据补全、改名及字幕旁车下载不因此停用。可在超级拼装的“工具与接口设置”中配置媒体工具路径。
* **找不到主题或自定义壁纸入口**：若“更多动效（实验中）”已开启，请先关闭；简洁模式会恢复这些入口与原有偏好。

## 已知限制

* 仅支持 Windows 10/11 x64
* 需要网络访问第三方元数据/字幕站点；站点结构变化可能导致解析失效
* 本地服务无鉴权，只监听 `127.0.0.1`，请勿暴露到局域网/公网
* 不做去重、转码、播放器集成
* “更多动效”仍处于实验阶段；已完成限定环境下的浏览器检查，尚未进行长期运行或跨显卡性能测量。图片本身为静态，本轮没有接入 2.5D 动态场景。
* 安全移动限本地同卷普通文件和所需硬链接能力；跨卷、网络盘或无法保证安全的输入会被拒绝。旧撤销日志缺少历史校验信息时需人工复核，不自动移动或删除文件；旧程序不能继续写入新格式日志及恢复中间态。
* 修复阶段 Node 24.22.1 / 26.13.0 的 26 文件安全集合各 272 项通过；完整项目 `npm test`、覆盖率和 CI 未运行。Node 22 与真实 FFmpeg / FFprobe 受 Windows `0xC0000142` 阻碍，真实封面嵌入及部分端到端验证仍未完成。详见[公开验证范围](docs/V081_RELIABILITY.md)；限定子集不能视为完整验收。

## 数据与隐私

* 视频、字幕与文件整理在本机完成；不收集遥测、不上传视频或文件列表。图片反查在主动搜索时上传所选截图，图片与结果不持久保存；可选密钥仅保存于本地独立文件，不进入配置导出与诊断。
* 运行数据（任务记录、journal）保存在本地 `data/`。删除前先停止程序并备份；删除会丢失任务历史及撤销所需依据。
* 提交 Issue 时请**不要**附真实影片文件、封面、截图中的个人路径。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
前端实验模式说明见 [MORE\_EFFECTS.md](docs/MORE_EFFECTS.md)；独立项目审查任务模板见 [PROJECT\_AUDIT\_PROMPT.md](docs/PROJECT_AUDIT_PROMPT.md)。

## License

[MIT](LICENSE) © 2026 Qrispoon

产品图像及第三方资源的来源记录与待确认许可见 [ASSET\_NOTICES.md](docs/ASSET_NOTICES.md)；仓库 MIT 许可不代表这些资源均可按 MIT 再分发。

\---

## English (short)

**\[AVC 补全器]** is a Windows local video-library organizer: detect titles from filenames,
fetch metadata, rename by template, and download Simplified Chinese subtitles. Dry-run by default,
changes are journaled and undo is conservative; embedded cover replacements keep the new media bytes. Node.js >= 22.13, zero dependencies.

**Source version v0.8.1 (2026-11-11)** combines **More effects (experimental)** with the A01–A21 reliability fixes for file operations, undo, field locks, preview scope, cancellation, persistence, backups, networking, and subtitles. The visual mode starts disabled, remembers the browser's choice, and restores simple-mode preferences when switched off. See [release notes](CHANGELOG.md#081---2026-11-11), [mode details](docs/MORE_EFFECTS.md), and the [public validation summary](docs/V081_RELIABILITY.md). This version update does not publish a remote release or download package.

The repair-stage safe subset passed 272 tests on each of Node 24.22.1 and 26.13.0. The full project suite, coverage, and CI were not run; Node 22 and real media-tool validation remain blocked by Windows `0xC0000142`. See the [public validation summary](docs/V081_RELIABILITY.md). Cover embedding replaces the current media while preserving field locks; undo retains the embedded cover and cannot restore the pre-embedding video bytes.

This tool is intended **only** for organizing media you legally own and may process. It does not
provide, download, or upload any video content, and it does not bypass paywalls or DRM. Metadata is
fetched from third-party sites; all rights belong to their owners. The local service has no
authentication and binds to `127.0.0.1` only — never expose it to a network.

See [Releases](https://github.com/Qrispoon/Yuyuko-AVC/releases) for the portable Windows build.
Contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

