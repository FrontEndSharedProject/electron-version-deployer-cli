# 02: 客户端强制更新（Force Update）判定、弹窗 UI、模板协议版本回退与关闭即退出生命周期

**What to build:** 客户端依据**远程版本元数据（Remote Version Metadata）**中的**最低支持版本（Minimum Supported Version）**判定是否进入**强制更新（Force Update）**模式（ADR-0002）。强制模式下，更新弹窗的窗口标题与顶部提示展示为“版本过低，必须安装新版本”，初始界面与错误面板的关闭类按钮改为“退出软件”；**普通更新（Optional Update）**行为保持不变。本地依赖目录中的弹窗模板协议版本与主进程不匹配时，回退到编译内嵌模板。强制模式下，除覆盖安装写入期间拦截关闭、更新完成后放行重启外，任何关闭弹窗的行为都调用 `app.exit(0)` 退出整个应用（ADR-0001）。

**Blocked by:** None (can start immediately)

**前置:** 工作区中未提交的 `UpdateProgressTracker`、`isUpdating`、错误面板与 `test/electron-e2e.test.cjs` 脚手架需先提交为基线，本 ticket 依赖它们。

**Status:** done

## 与 01 共享的约定

- 远程版本元数据即客户端拉取的远程 `package.json`，最低支持版本在其顶层可选字段 `minSupportedVersion`。
- 强制模式判定：远程 `version` 高于本地，且 `minSupportedVersion` 匹配 `^\d+\.\d+\.\d+$`，且本地版本低于它（用 `versionToNum` 比较）。字段缺省或格式非法一律按普通更新处理。

## 设计要点

- **主进程是唯一权威。** 强制模式状态只存在主进程，渲染层只负责展示。强制模式下主进程收到 `evd-skip` 一律按退出处理，即使加载到旧模板，点“稍后再提醒我”也会退出。
- **模式下发要可订阅。** 渲染层通过 IPC 获取初始模式，并订阅主进程推送的模式变更事件，不要用一次性 URL 参数，03 的原位升级直接复用。事件名加入 `EVDEventEnum`。
- **窗口标题要在页面里改。** 模板 `<title>有可用的更新</title>` 会通过 `page-title-updated` 覆盖 BrowserWindow 的 `title`，所以构造参数里设 `title` 不够，需要同时更新 `document.title`，或拦截该事件。
- **模板协议版本。** 模板加入 `<meta name="evd-template-version" content="N">`（整数，模板与主进程的 IPC/DOM 约定变化时递增），主进程内置所需版本常量。本地依赖目录中的模板版本不相等（含缺失该标记的旧模板）时，回退加载内嵌模板。模板经 `public/` 原样拷贝，不做构建期注入。
- **关闭处理（仅强制模式）**，把 `once("close") → cleanup → destroy` 改为 `on("close")` 统一处理：
  - `stage === "install"`（安装子进程正在覆盖本地文件）：`preventDefault`，保留弹窗；
  - 已进入重启流程：放行关闭。必须在成功路径的 `promptWindow.close()` 之前置位标记，否则 `close` 先于 `app.relaunch()` 执行，会被当成退出；
  - 其余情况（初始界面、precheck 等待 `onBeforeNewPkgInstall`、下载、解压、错误面板）：`app.exit(0)`。下载与解压只写临时的 `evdUnzip(.zip)`，中途退出不会损坏安装目录，不应把用户锁在弹窗里。
- **现有“只剩一个窗口就关闭弹窗”的逻辑**（`ready-to-show` 中给全部窗口挂 `closed` 监听）：强制模式下改为 `app.exit(0)`。否则弹窗被 `destroy`，macOS 上应用留在 Dock 里且没有弹窗，要等下次轮询才会再弹。
- 普通更新模式的关闭、跳过行为不变。

## 代码入口

- `src/main.ts`：`EVDCheckUpdate`（判定）、`showNewVersionDialog`（模板解析、窗口创建、`closed` 监听）、`bindEvent`（`SKIP` 与成功路径 `close → relaunch → exit`）、`cleanup`
- `public/templates/newVersionDialog.html`：`<title>`、初始界面 `#skipBtn`、错误面板 `#closeBtn`（`#retryBtn` 与 `#copyErrorBtn` 保留）
- `test/electron-e2e.test.cjs`：`startMockUpdateServer` 可直接下发带 `minSupportedVersion` 的远程元数据

## 验收

- [x] 本地版本低于合法的 `minSupportedVersion` 且远程版本更高时进入强制模式：窗口标题（含 `document.title`）与顶部提示为“版本过低，必须安装新版本”，`#skipBtn` 与 `#closeBtn` 文案为“退出软件”，`#retryBtn` 与 `#copyErrorBtn` 保留
- [x] `minSupportedVersion` 缺省、格式非法或本地版本不低于它时，保持普通更新原有标题、“稍后再提醒我”及关闭弹窗不退出应用的行为
- [x] 强制模式由主进程判定并通过可订阅的 IPC 下发；强制模式下主进程收到 `evd-skip` 即退出
- [x] 模板带 `evd-template-version` 标记；本地依赖目录中的模板版本不匹配或缺失标记时回退内嵌模板，匹配时沿用本地模板
- [x] 强制模式下，初始界面或错误面板点击“退出软件”、系统关闭按钮、precheck / 下载 / 解压阶段关闭弹窗，均调用 `app.exit(0)`
- [x] 强制模式下，`install` 阶段拦截弹窗关闭；更新成功后放行关闭并正常执行 `app.relaunch()`，不会提前退出
- [x] 强制模式下，宿主其它窗口全部关闭只剩弹窗时调用 `app.exit(0)`，而不是销毁弹窗
- [x] Electron 端到端测试覆盖：强制与普通两种模式的文案与按钮、旧模板回退、点击退出与关闭弹窗触发退出、`install` 阶段防关闭、更新成功后正常重启、只剩弹窗时退出
- [x] README 补充强制更新的客户端行为、模板协议版本回退，并说明 `app.exit(0)` 会跳过宿主的 `before-quit` / `will-quit` 收尾，以及旧客户端会忽略最低支持版本
