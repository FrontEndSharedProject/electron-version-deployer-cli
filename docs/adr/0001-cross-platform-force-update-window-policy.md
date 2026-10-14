# 跨平台强制更新窗口阻断与退出策略

在强制更新（Force Update）模式下，更新弹窗保持系统原生可关闭状态（`closable: true`）并设置 `skipTaskbar: false`，在弹窗初始界面与错误面板提供“退出软件”按钮；除覆盖安装写入本地文件期间拦截关闭（下载与解压只写临时目录，中途退出不会损坏安装目录）、以及更新完成后的重启流程放行关闭外，其余弹窗关闭行为均直接调用 `app.exit(0)` 终止进程。主进程以隐藏除更新弹窗外的其它窗口（`win.hide()`）作为跨平台主手段，并监听 `browser-window-focus`、`browser-window-created` 及每个窗口的 `show` 事件持续阻止主窗口被唤醒（`showInactive()` 或应用不在前台时的 `show()` 不会触发聚焦事件）；`win.setEnabled(false)` 仅作为非 macOS 平台的补充，用于防止窗口被重新显示到再次隐藏之间的瞬时交互。未采用仅在 Windows/Linux 生效的 `setEnabled(false)` 作为主手段，也未采用在 Windows 11 下存在点击消失缺陷的 `alwaysOnTop: true`。
