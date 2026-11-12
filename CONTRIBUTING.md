# 贡献指南 / Contributing

感谢你愿意帮忙。这个项目是一个人维护的 Windows 小工具，请先读完再动手。

Thanks for helping! This is a small, single-maintainer Windows tool. Please read this first.

## 欢迎的贡献 / Welcome

- 报告可复现的 Bug（附 Windows 版本、Node 版本、命令、日志，**不要附真实影片文件或截图**）
- 改进文档、修正错别字、补充英文翻译
- 改进解析器、时间轴校正、撤销逻辑，并附带测试
- 性能与稳定性修复

## 不接受的贡献 / Not accepted

- 提交任何影片、字幕、封面、站点页面快照等第三方内容
- 要求内置"在线刮削服务"、账号池、代理池、破解/去 DRM 功能
- 大规模重构、更换框架、引入构建工具或运行时依赖（本项目刻意保持零依赖）
- 与现有目标无关的功能堆叠（请先开 Issue 讨论）

## 开发 / Development

```powershell
# 需要 Node.js >= 22.13（推荐 24 LTS / 26）
node --version
# 所有支持版本共用完整测试文件发现入口；不向 Node 传 tests/ 目录。
npm test                   # 检查失败项及跳过原因后再提 PR
npm run test:coverage      # 与 npm test 使用相同文件集合
node tools/test.mjs --list  # 只列文件，不导入或执行用例
node src/server.mjs --port 17890
```

- 代码风格：ESM、零第三方依赖、2 空格缩进、单引号；沿用现有文件的写法即可。
- 新增解析逻辑必须配测试；测试不得依赖真实网络与真实站点快照（用 `tests/fixtures/` 的合成数据）。
- 提交信息：`type(scope): 摘要`，例如 `fix(subs): handle BOM in SRT`。
- 一个 PR 只做一件事；先开 Issue 说明动机，再提 PR。

## 安全 / Security

请勿在公开 Issue 中报告安全漏洞，见 [SECURITY.md](SECURITY.md)。

## 许可 / License

提交贡献即表示你同意以本仓库的 LICENSE（MIT）发布你的贡献。
By contributing, you agree that your contributions are licensed under the repository's LICENSE (MIT).

## 测试 / Tests

核心回归使用合成夹具，不需要真实媒体、真实站点快照或外部网络；`fixtures/` 与第三方内容不应随仓库提交。测试数量会变化，应记录实际运行环境、执行命令、通过／失败／跳过数量及跳过原因，不把“全部运行项通过”写成“全部功能已验证”。

**测试入口兼容性**：`npm test`、`npm run test:coverage` 与 CI 共用 `tools/test.mjs`，稳定递归发现全部 `.test.mjs` / `.test.cjs` / `.test.js` 文件，以当前 Node 可执行程序和参数数组启动测试，不依赖 shell 通配符或目录参数。发现为空、无法读取、链接条目或命令行过长会明确失败；不会截断清单或静默漏测。`--list` 只列文件，不能证明测试通过。Windows Node 22.13 / 24 / 26 的实际兼容结果应分别记录。

**公开打包清单**：两个 ZIP 构建器共用 `tools/lib/public-files.mjs`。文档与界面资源逐文件列举；源码只接收受限目录内的 `.mjs`，拒绝本地配置、敏感目录、越界与链接。未知文档、截图、审查报告不会自动分发。新增运行模块后，须同步 package.json 的精确 `files` 清单；`tests/repair-packaging.test.mjs` 会检查二者一致。构建器可以导入并传入自建的 `root`、`outputDir` 做隔离验证，正常命令仍使用 `dist`，同名 ZIP 已存在时明确拒绝覆盖。不会再清理共享 `dist/pack`；如需重建，应由使用者先保留既有归档或指定新输出目录。

**受限验证**：运行前检查测试模块及顶层夹具是否符合当前授权范围。现有完整套件含本机跨源拒绝和目录联接负向用例；禁止该类操作的审查/修复会话不得直接执行完整入口，应保留未运行原因，选择明确审核过的安全子集并准确标注。这个会话约束不改变产品默认完整测试或 CI 的发现语义；子集通过不能记作 `npm test` 通过，也不得靠删除、默认跳过或隐藏原用例制造全绿。

**可选浏览器检查**：已安装 Playwright 与 Edge 的开发环境可运行 `node tools/check-effects-ui.mjs`；如包不在项目依赖目录，通过 `AVC_PLAYWRIGHT_PATH` 指向已有 Playwright 包。应用运行不需要安装该依赖。
该脚本使用专用临时配置、数据与浏览器存储，输出到被忽略的 `docs/screenshots/local/more-effects/`。不应在真实用户媒体上执行预演外的写入测试；具体覆盖与限制见 [更多动效说明](docs/MORE_EFFECTS.md)。

**独立审查**：可使用 [项目审查任务模板](docs/PROJECT_AUDIT_PROMPT.md)。先记录现有工作区状态，只在隔离数据上复现，不清理或重置他人的改动；审查报告需要源码位置、触发条件、复现结果、影响和未验证范围。

## 首次推送 / Before pushing

首次推送前，确认 Git 仓库已有预期的提交历史、当前分支、远端地址和将要提交的文件清单；检查 `git status`、`git remote -v` 与忽略规则。未初始化仓库、尚无首次提交、没有远端是不同状态，不要用重置、强推或自动打标签来代替确认。不要提交本机配置、数据库、媒体、日志、审查证据或构建包。README 中的图片来源与许可待办需在公开分发相关资源前处理。准确说明实际运行过的测试和未覆盖范围；准备检查不等于已提交或已推送。
