# 安全策略 / Security Policy

## 报告方式 / Reporting

请通过 GitHub 的 **Private vulnerability reporting**（仓库 → Security → Advisories → Report a vulnerability）提交，
不要开公开 Issue。若该功能暂不可用，可在 Issue 中只写"需要私密联系方式"，不要附敏感细节。

Please report vulnerabilities privately via GitHub Security Advisories. Do not open a public issue.

## 安全边界 / Scope

这是一个**本地单用户**工具，设计上**没有鉴权**，请务必了解以下事实：

- 后端默认只监听 `127.0.0.1:17890`，**不要**用 `--host 0.0.0.0` 暴露到局域网/公网。
- 能访问该端口的本机程序仍可能调用 API（配置、扫描、改名、撤销、目录浏览）。v0.8.1 已校验实际监听地址的 Host、请求 Origin 与路由 Content-Type，并保留普通本地 JSON 客户端兼容；这些保护不构成账号鉴权。
  不要把端口转发出去，也不要把本地配置、密钥或数据目录暴露给不可信程序。相关拒绝验证限于静态和内存模拟，不能据此宣称所有浏览器攻击路径均已实测排除。
- 工具会按你的配置读写视频目录（改名、写 `.srt`/封面）。请只对你有权限、且已备份的目录使用。
- 工具不收集遥测，不上传本地文件列表；但会按配置访问元数据站点与字幕源，请自行确认当地法律与站点条款。

## 支持版本 / Supported versions

仅支持最新 Release。旧版本请先升级再报告。
