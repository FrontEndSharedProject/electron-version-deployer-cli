# Changelog

## [0.6.0] - 2026-10-16

### ⚠️ 破坏性变更

- `extraFolders` 不再由 `evd deploy` / `evd preDeploy` 原样复制进 `node_modules/.evd/<basename>` 部署到远程服务器，改为由 `evd prepare` 打进 `fullCode.zip` 与 `logicCode.zip` 根层级的 `<basename>/`，客户端热更新后写入 `app.getAppPath()/<basename>`。依赖 `<remoteUrl>/<basename>/...` 托管静态文件的项目，升级后下一次部署这些地址会 404，迁移方式见 README「0.6.0 版本说明与升级指南」。

### 新增

#### 客户端：强制更新

- 远程 `package.json` 声明了合法的 `minSupportedVersion`（`x.y.z`）且本地版本低于它时进入强制更新：弹窗标题与提示变为「版本过低，必须安装新版本」，关闭类按钮变为「退出软件」；宿主其它窗口被隐藏，重新显示、聚焦或新建时会再次被隐藏；关闭弹窗即退出应用，覆盖安装本地文件期间拦截关闭。已打开的普通更新弹窗在后续检测命中强制更新时原位升级。
- `EVDInit` 新增 `onBeforeForceExit(next)`：强制更新模式下用户选择退出前调用，调用 `next()` 后才退出，可用于保存未落盘的数据；回调抛错或 reject 时直接退出。

#### 客户端：更新进度与诊断

- 更新弹窗展示「环境检查 → 下载 → 解压 → 更新本地文件 → 重启」五个阶段的进度、百分比、当前处理文件与已用时间；超过 10 秒无进展时提示可能原因，并提供「复制当前诊断信息」。
- 更新前检查运行环境，新增错误码 `APP_TRANSLOCATION`（macOS 随机只读沙盒）、`READ_ONLY_VOLUME`（只读卷或 DMG）、`DISK_FULL`；`EVDError` 新增 `stage` / `progress` / `filePath` 字段，错误面板同步展示。
- 弹窗模板带协议版本标记 `evd-template-version`，`node_modules` 中的模板缺失标记或版本不匹配时自动改用内嵌模板；应用目录只读时模板写入系统临时目录，保证错误面板仍能显示。

#### CLI：最低支持版本

- `evd.config.js` 新增 `minSupportedVersion`；`evd deploy` / `evd preDeploy` 新增 `--min-supported-version <version>`、`--force-update`、`--no-force-update`（三者互斥）。本次生效值低于远程现值（含取消）且不是来自 CLI 参数时，需要交互确认或 `--allow-min-version-downgrade`。
- `evd verify` 校验远程 `minSupportedVersion` 与本地一致。

#### 增量包分片与远程校验

- `zipSplit` 同时作用于 `logicCode.zip`（`logicCodeZipSplitZips/`），两个包按各自体积独立判断是否达到 `thresholdMB`；客户端下载增量包时自动探测并合并分片。`--split` 与 `--no-split` 同时传入会报错。
- `evd prepare` 会清理 `.evd` 中残留的历史分片目录。
- `evd verify`：本地已分片时校验远程分片清单与本地一致；本地未分片时，远程残留的历史分片清单会判失败（客户端会优先下载这些旧分片）。

#### extraFolders

- 支持静态数组、同步函数与异步函数，兼容相对项目根目录的路径与绝对路径，在编译完成后解析；目录名与 `sources.codes`、`sources.nodeModules`、`package.json`、`evdUnzip` 冲突或彼此重名时报错。

### 修复

- 多次调用 `EVDCheckUpdate()` 或定时检测再次命中新版本时会叠加打开多个更新弹窗，现在复用同一个弹窗；重复调用 `EVDInit` 不再叠加定时检测任务。
- 覆盖安装超过 5 分钟未完成会被当作成功并重启应用，安装子进程异常退出也会被当作成功，现在都报 `INSTALL_FAILED`。
- 更新完成、下载失败或安装失败后，应用目录下残留的 `evdUnzip.zip`、`evdUnzip/`、`_evdInstallerTmp.js` 现在会被清理。
- 版本号某一段达到 5 位数字时版本比较出错。
- 远程 `package.json` 缺少 `version` 时抛出 `TypeError`，现在报 `REMOTE_INVALID_JSON`。
- changelog 取不到时点击「所有版本更新记录」会在弹窗内跳转，链接内含加粗等子元素时点击无效，现在统一用系统浏览器打开。
- wrangler / netlify 部署失败（含命令不存在）或 `evd.config.js` 加载出错时，CLI 以未捕获异常崩溃，现在输出错误并 `exit 1`。
- `evd install-prebuilt` 不等待下载完成，下载失败时以未捕获异常退出，现在等待全部下载并在失败时 `exit 1`。
- `evd init` 在 `package.json` 没有 `name` 字段时报错。

## [0.5.2] - 2026-09-22

### 修复

- 软件装在普通用户没有写入权限的目录（如 Windows 的 `C:\Program Files`）时，更新失败会被报成「下载更新包失败，请检查网络连接后重试」「更新包解压失败，请重试」或英文原始错误，用户无从下手。现在统一报新增的 `PERMISSION_DENIED`，Windows 下提示完全退出软件后右键「以管理员身份运行」再重新更新。
- 更新弹窗模板写入失败时 `onError` 收到的是原始 `Error`，现在同样转换为 `EVDError`。

## [0.5.1] - 2026-08-08

### 新增

- `EVDInit` 新增 `silentAutoCheck`（默认 `false`）：为 `true` 时，自动检查更新（启动检测 + 定时轮询）失败不再触发 `onError`。适用于更新地址需要 VPN 的场景，避免用户软件刚启动、VPN 还没连上就被弹窗打扰。
- `EVDInit` 新增 `onAutoCheckError`：自动检查更新失败时的独立回调，可只写日志不提示用户。提供后自动检查的错误只走它，不再走 `onError`；两者都不提供时行为与旧版本一致。
- 手动调用 `EVDCheckUpdate()` 不受上述两个参数影响，错误依旧以 rejected Promise 抛出，可自行 `.catch()` 提示；下载与安装阶段的错误也依旧走 `onError`。

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
