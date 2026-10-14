# 03: 强制更新（Force Update）跨平台主窗口阻断、防唤醒拦截与在线弹窗原位升级

**What to build:** 遵循 ADR-0001，客户端进入**强制更新（Force Update）**模式时，把更新弹窗设为任务栏可见，隐藏宿主应用中除更新弹窗外的全部窗口（非 macOS 平台补充禁用交互），并在强制模式期间持续拦截：任何非弹窗窗口被重新显示、聚焦或新建，立即隐藏并把焦点切回弹窗。此外，已打开的**普通更新（Optional Update）**弹窗在后续检查中判定为强制模式时，原位升级为强制模式。

**Blocked by:** 02: 客户端强制更新（Force Update）判定、弹窗 UI、模板协议版本回退与关闭即退出生命周期

**Status:** ready-for-agent

## 设计要点

- **任务栏可见。** 进入强制模式时调用 `setSkipTaskbar(false)`（Windows/macOS 生效，Linux 忽略），保证主窗口隐藏后仍能从 Windows 任务栏与窗口切换器找回弹窗。
- **主窗口阻断。** 对除弹窗外的全部窗口调用 `hide()`；非 macOS 平台再补充 `setEnabled(false)`，防止窗口被重新显示到再次隐藏之间的瞬时交互。
- **防唤醒监听。** 只监听 `browser-window-focus` 不够：`showInactive()`、应用不在前台时 macOS 上的 `show()`、以 `show: false` 新建后再显示的窗口，都不会触发聚焦事件。需要：
  - 进入强制模式时，给现有窗口逐个挂 `show` 监听；
  - `browser-window-created` 时给新窗口挂同样的监听，并立即隐藏；
  - `browser-window-focus` 兜底。

  三条路径命中后都执行“隐藏该窗口 + 聚焦弹窗”。macOS 点击 Dock 图标时，宿主 `activate` 里的 `show()` 由上述监听拦截，允许短暂闪现。
- **强制模式不可逆。** 强制模式只以退出或重启结束，不需要恢复窗口；同一会话内远程改回普通更新，也保持强制模式。
- **原位升级。** `EVDCheckUpdate` 发现已有弹窗时，重新判定模式（02 的判定规则）。由普通变为强制时，通过 02 的模式变更事件推送渲染层，调用 `setTitle`，然后执行任务栏可见与主窗口阻断。如果升级时正在更新或处于错误面板，02 的关闭规则立即生效，错误面板按钮同步变为“退出软件”。

## 代码入口

- `src/main.ts`：`showNewVersionDialog`（已有弹窗时目前只做 `show/focus` 后返回，原位升级在此分支接入）、`EVDCheckUpdate`
- `test/electron-e2e.test.cjs`：mock 服务器需支持在场景中切换远程元数据，场景中手动调用 `EVDCheckUpdate` 触发再次检查（默认轮询间隔 6 小时）

## 验收

- [ ] 强制模式下弹窗 `skipTaskbar` 为 `false`
- [ ] 进入强制模式时隐藏除弹窗外的全部现有窗口，非 macOS 平台同步 `setEnabled(false)`
- [ ] 强制模式期间，现有窗口被 `show()` / `showInactive()` / 聚焦，或宿主新建窗口（含 `show: false` 后再显示）时，自动隐藏并聚焦回弹窗
- [ ] 已打开的普通更新弹窗在再次检查中判定为强制模式时，原位升级标题、文案、按钮、任务栏可见性，并立即阻断其它窗口；远程改回普通更新时保持强制模式
- [ ] Electron 端到端测试通过 `show()` / `showInactive()` / `new BrowserWindow` 主动触发拦截路径，不依赖 CI 环境下不稳定的系统聚焦事件；覆盖主窗口自动隐藏、防唤醒、新建窗口拦截、普通到强制的原位升级、强制模式不回退
- [ ] README 补充强制模式下主窗口会被隐藏的行为说明
