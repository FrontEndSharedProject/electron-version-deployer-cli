# Changelog

## [0.5.0] - 2026-08-06

### 新增

#### CLI：自建服务器部署支持

- 新增 `evd preDeploy`（别名 `pre-deploy`）：非交互的部署前检测，跑完 `deploy` 的全部检测逻辑 + `extraFolders` 复制 + 压缩包整形，通过后 `node_modules/.evd` 可直接由 CI 上传。命中风险项报错并 `exit 1`，用 `--allow-first-deploy` / `--allow-name-mismatch` / `--allow-same-version` / `--allow-downgrade` / `--force` 显式放行。
- 新增 `evd verify`：上传完成后校验远程链接真的生效，检查远程 `package.json` 的 name/version 与本地一致，以及 `changelog.json`、`changelogs.html`、`logicCode.zip`、`fullCode.zip`（或全部分片）可访问。支持 `--retry` / `--retry-delay` 应对 CDN 传播延迟。
- 新增 `selfHosted: { url }` provider，用于由 CI 命令（rsync / scp 等）自行上传的场景。provider 探测顺序为 `netlify` → `cloudflare` → `selfHosted`。
- 新增 `zipSplit: { enabled, thresholdMB, chunkSizeMB }` 配置，可控制 `fullCode.zip` 是否拆分。默认按 provider 推断：cloudflare 为 `true`，netlify 与 selfHosted 为 `false`（自建服务器没有 25MB 单文件限制）。也可用 `--split` / `--no-split` 临时覆盖。

#### 客户端：更新错误类型化

- 新增 `EVDError`，`onError` 回调收到的错误带 `code`、`phase`（`check` / `download` / `install`）、`url`、`statusCode`、`cause` 字段，可按类型分别提示用户。
- 新增 `EVDErrorCodeEnum`：`NETWORK_TIMEOUT`、`NETWORK_UNREACHABLE`、`SSL_ERROR`、`HTTP_ERROR`、`REMOTE_NOT_FOUND`、`REMOTE_INVALID_JSON`、`DOWNLOAD_TIMEOUT`、`DOWNLOAD_FAILED`、`UNZIP_FAILED`、`INSTALL_FAILED`、`NOT_INITIALIZED`、`UNKNOWN`。
- 新增 `isEVDError()`、内置中文文案表 `EVD_ERROR_MESSAGES`、以及 `formatEVDErrorDetail()`（生成可直接发给开发者排查的完整错误信息）。
- 更新弹窗新增错误面板：下载或安装失败时显示错误文案、错误码与完整详情，提供「重试」「复制错误信息」「关闭」三个按钮。「复制错误信息」会把时间、平台、阶段、错误码、当前版本、更新地址、出错 URL、状态码、原始错误与堆栈写入剪贴板。
- `EVDInit` 新增 `requestTimeout`（检测请求超时，默认 10000ms）与 `downloadStallTimeout`（下载停顿超时，默认 60000ms）。

### 修复

- 更新弹窗在下载失败后会永久停留在「软件更新中……」遮罩上，用户看不到任何提示。
- 下载更新包没有任何超时保护，连接挂起会永久卡住。改为停顿超时，连续指定时长没有新数据才判定超时，慢速网络下载大包不会被误杀。
- 下载更新包不校验 HTTP 状态码，404 返回的 HTML 页会被原样写进 zip，随后抛出难以理解的解压错误。
- `installNewVersion` 内部吞掉错误后正常 resolve，导致下载失败时软件仍然会重启。
- 分片下载失败后没有中断循环，仍会继续下载剩余分片。
- 安装子进程失败时只写入 `evdInstallerErrors.txt` 就以 0 退出，主进程当成功处理。现在会上报 `INSTALL_FAILED`。
- `netRequest` 的 fetch 兜底分支未检查响应状态码，非 2xx 会被当作正常响应解析。
- 检测更新的请求超时从写死的 5s 调整为可配置，默认 10s。
- `remoteUrl` 带尾斜杠时会拼出 `//package.json`，部分 CDN 与对象存储会直接 404。现在统一做归一化。
- `extraFolders` 的复制只在 `deploy` 中执行，只跑 `evd prepare` 再手动上传时会静默丢失这些文件夹。已移入共享检测流程，`preDeploy` 同样生效。
- `evd prepare` / `evd deploy` 失败时不设置退出码，CI 中失败也会显示为成功。现在失败时 `exit 1`。

### 说明

- `remoteUrl` 支持子目录形式的地址（如 `https://cdn.example.com/app/my-project`），末尾带不带 `/` 均可。
- 客户端对不拆分的更新包自动兼容，无需改动；关闭拆分时会自动清理 `.evd` 中遗留的 `fullCodeZipSplitZips` 目录，避免客户端读到旧的分片描述文件。
