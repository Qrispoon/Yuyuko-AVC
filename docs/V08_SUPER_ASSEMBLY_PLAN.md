# “超级拼装”v0.8.0 实施清单

日期：2026-11-09。基线：v0.7.5。状态：用户已批准正式开发，已实现本地字幕嵌入和图片反查，交付版本 v0.8.0。

本文依据最终确认范围整理。原网页 Demo 保留为历史界面评审资料，不再作为待批准的实施门槛。实际操作与限制以 [v0.8.0 使用说明](V080_SUPER_ASSEMBLY.md) 为准。

## 最终范围

| 项目 | 交付方式 |
|---|---|
| 顶部导航 | 历史与撤销 → 超级拼装 → 设置；页内切换字幕嵌入和图片反查 |
| 字幕来源 | 仅本地 SRT。同名优先，可填写其他授权路径；没有字幕先在工作台下载 |
| 输出 | 音视频 stream copy，新增可切换字幕；另存 MP4 / MKV，不替换源文件 |
| 重复与旧轨 | 抽取归一化文本字幕比较；相同字幕跳过，其他旧轨明确确认保留 |
| 执行 | 固定计划、前后校验、独立临时目录、拒绝覆盖发布、进度、取消 |
| 历史与撤销 | 复用普通任务历史；字幕嵌入专用报告；v2 日志只删除未改变的输出 |
| 图片反查 | 用户配置 avscan.cc 兼容接口；选择 / 拖放 / 粘贴截图，手动点击上传 |
| 结果 | 番号、百分比相似度、命中时间，仅提供复制番号 |
| 视觉 | 粉樱卡片、原有壁纸和樱花、中英文、字号、深浅主题、窄屏布局 |

不开发 Whisper、机翻、目录配置档、问题中心、新队列管理面板、原位替换视频、硬字幕烧录、远程结果帧图，也不将图片结果接入预演、修正或改名。

## 实现分层

1. `src/media/mux.mjs`：FFmpeg / FFprobe 子进程、JSON 探测、字幕归一化、旧轨检查、stream copy 参数、输出校验、进度与流式 SHA-256。取消和超时均等待进程关闭。
2. `src/core/assembly.mjs`：本地素材发现、真实路径授权、SRT 读取、计划冻结与消费、执行、拒绝覆盖发布、v2 媒体撤销。
3. `src/core/assembly-settings.mjs`：独立工具 / 接口配置，校验地址与鉴权头，密钥不从 API 回传。
4. `src/net/upload.mjs`、`src/sources/frame-search.mjs`：单次有界 POST、可选 CONNECT 代理、不重试不重定向、图片头与尺寸检查、上游响应归一化。
5. `src/server.mjs`：专用分析 / 搜索 / 开始接口，普通任务持久化与进度，维护互斥；拒绝忙时隐式追加封装任务。
6. `web/assembly.js`、`web/assembly.css`：真实数据页面；模块文案即时中英文切换，继承原有主题变量。
7. `src/core/assembly-report.mjs`：独立可读封装报告；`src/core/backup.mjs` 备份封装计划与原有任务 / journal。

## 流程

字幕：读取目录 / 导入勾选 → 指定 SRT → 设置容器与语言 → 分析并冻结 → 确认旧轨 → 执行 → 校验字幕和媒体 → 计算输出指纹 → 发布 → 历史报告 / 撤销。

计划记录源视频身份（大小、mtime、inode、设备、创建时间）、字幕原始字节 SHA-256、输出真实目录和工具路径。执行前和发布前重新校验；24 小时有效，执行后消费。发布前写入指纹日志，使用硬链接原子拒绝覆盖。意外退出后已发布的输出可从 journal 核对并撤销；不自动续跑，硬退出遗留临时目录由用户确认后清理。

图片：选择 / 拖入 / 粘贴 → 本地重新编码 JPEG 并显示最终预览 → 用户主动搜索 → 后端 multipart `file` → 清洗番号 / 相似度 / 时间 → 复制。图片和结果不持久化。原图限制 8 MB / 2500 万像素，最长边缩至 2048 像素，上传不重试、不自动跳转目的地。

## 接口协议依据

已阅读上游 README 与 `references/api.md`，公开协议足以由 Node 内置模块独立实现，无需 clone 或 Python。`POST https://avscan.cc/search`，表单 `file`，响应 `results[].video_code`、`best_similarity`、`frames[].image_name`，最多 20 条无分页，相似度直接为百分数。

来源：[avscan-frame-search](https://github.com/poisonhs/avscan-frame-search)、[API 说明](https://github.com/poisonhs/avscan-frame-search/blob/main/references/api.md)、[FFmpeg 文档](https://ffmpeg.org/ffmpeg.html)、[FFprobe 文档](https://ffmpeg.org/ffprobe.html)。不复制上游脚本，不内置服务数据。

## 验收与约束

- 原有回归测试保持通过；新增协议、路径、密钥、取消、输出占用与撤销测试。
- 真实自建短片验证 MP4 / MKV，源视频 hash 不变，相同字幕重复检测、保留旧轨、取消子进程、输出指纹保护。
- 浏览器验证真实页面嵌入 → 历史报告；隔离本地搜索接口验证选图、显示和复制；检查英文、主题与窄屏。
- 更新版本、启动日志、README、CHANGELOG、API、架构与路线图；测试二进制和夹具只在忽略目录中。
- 完整使用步骤、已知媒体兼容限制及持久化说明见 `docs/V080_SUPER_ASSEMBLY.md`。
