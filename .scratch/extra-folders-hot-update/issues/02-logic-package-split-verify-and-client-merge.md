# 02: 增量更新包（Logic Package）自动分片、远程生效校验（Remote Verification）与客户端分片拉取合并

**What to build:** 将**分片更新包（Split Package）**机制从仅支持**全量更新包（Full Package）**扩展为同时支持**增量更新包（Logic Package）**。复用现有的分片配置（默认在 Cloudflare 下开启，24MB 阈值、20MB 切片）及 CLI `--split` / `--no-split` 参数，对**全量更新包（Full Package）**与**增量更新包（Logic Package）**按各自体积独立判断是否达到或超过阈值；当**增量更新包（Logic Package）**达到阈值时，自动切分为 `logicCodeZipSplitZips/logicCode.partN.zip` 与 `logicCodeZipSplitZips/index.json` 并删除原整包。**远程生效校验（Remote Verification）**自动根据本地待上传目录中两种更新包的实际形态（整包或分片）校验远程可达性。客户端在下载**增量更新包（Logic Package）**时同样先探测 `logicCodeZipSplitZips/index.json`，若存在分片则按序下载、上报分片进度并流式合并为完整归档后完成解压与含 `extraFolders` 的覆盖安装。

**Blocked by:** 01: extraFolders 并入双更新归档、移除裸目录复制与客户端热更新落盘

**Status:** ready-for-agent

- [ ] 分片逻辑同时作用于**全量更新包（Full Package）**（`fullCode.zip` → `fullCodeZipSplitZips/fullCode.partN.zip` + `index.json`）与**增量更新包（Logic Package）**（`logicCode.zip` → `logicCodeZipSplitZips/logicCode.partN.zip` + `index.json`），共用 `zipSplit` 配置与 `--split` / `--no-split` 参数，按各自体积独立判断是否达到 `thresholdMB`
- [ ] 任一更新包已处于已拆分状态时，重复执行分片保持幂等跳过；已处于已拆分状态但传入 `--no-split`（或 `enabled: false`）时明确报错提示重新执行打包准备
- [ ] 当关闭分片或某个更新包体积未达到 `thresholdMB` 时，自动清理该包在待上传目录中残留的历史分片目录（不留空目录或旧 `index.json`），保留整包文件
- [ ] **远程生效校验（Remote Verification）**对**增量更新包（Logic Package）**与**全量更新包（Full Package）**统一按本地是否存在对应 `<splitFolder>/index.json` 分支校验：存在时校验远程 `index.json` 及全部分片文件，不存在时校验远程整包文件
- [ ] 客户端在拉取**增量更新包（Logic Package）**时自动探测远程 `logicCodeZipSplitZips/index.json`：存在有效分片列表时按序下载分片、上报分片下载进度、合并还原为完整 zip 并在 `finally` 中清理临时分片文件；不存在时直接下载 `logicCode.zip`
- [ ] 单元与集成测试覆盖：双包各自独立按阈值拆分与保留、重复执行幂等、已拆分后关闭分片报错、未达阈值时残留分片目录清理、增量分片包的远程生效校验
- [ ] Electron 端到端测试覆盖：依赖未变更时客户端拉取已拆分为 `logicCodeZipSplitZips` 的**增量更新包（Logic Package）**（内含 `extraFolders`），完成分片下载、合并、解压并将 `extraFolders` 递归覆盖写入 `app.getAppPath()/<basename>`
- [ ] 更新 `README.md` 中关于 `extraFolders` 热更新、`zipSplit` 与 `--split` / `--no-split` 的文档说明
