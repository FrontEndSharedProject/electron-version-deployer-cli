# 01: extraFolders 并入双更新归档、移除裸目录复制与客户端热更新落盘

**What to build:** 在打包准备阶段（应用编译与更新日志生成完成后）解析并校验 `extraFolders` 配置（支持静态字符串数组、同步函数与异步函数，同时兼容相对项目根目录的相对路径与绝对路径），将解析后的目录一并打入**全量更新包（Full Package）**与**增量更新包（Logic Package）**的根层级（`<basename>/...`），并移除部署与**预部署检测（Pre-deploy Check）**阶段向待上传目录直接复制未压缩裸文件夹的行为。客户端执行热更新解压后，安装子进程将 `extraFolders` 对应的顶层目录递归覆盖写入客户端本地 `app.getAppPath()/<basename>`（同名文件覆盖、新增文件创建，不删除本地旧目录）。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 打包准备阶段支持解析 `string[]`、`() => string[]`、`() => Promise<string[]>` 三种形式的 `extraFolders`，且在应用编译完成后调用；未配置或返回空数组时正常跳过
- [x] `extraFolders` 中的条目同时支持相对项目根目录的相对路径与绝对路径
- [x] 当 `extraFolders` 条目路径不存在或不是文件夹时，抛出明确错误并以非零状态退出
- [x] 当 `extraFolders` 条目之间存在同名 `basename`，或 `basename` 与业务代码目录、依赖目录、`package.json` 名称冲突时，抛出明确错误并以非零状态退出
- [x] 解析通过的 `extraFolders` 目录同时被打入**全量更新包（Full Package）**与**增量更新包（Logic Package）**的顶层 `<basename>/` 下
- [x] 部署与**预部署检测（Pre-deploy Check）**阶段不再向待上传目录复制未压缩的 `extraFolders` 裸文件夹；若待上传目录中存在历史遗留的同名裸文件夹，在打包准备阶段予以清理
- [x] 客户端执行热更新后，`extraFolders` 中的文件被递归覆盖写入本地 `app.getAppPath()/<basename>`（原有同名文件更新、新增子目录与文件写入、本地原有的其它历史文件保留不删）
- [x] 单元与集成测试覆盖：静态数组/同步函数/异步函数解析、相对与绝对路径、不存在/非文件夹/重名/保留名冲突报错、双更新包内含 `<basename>/` 且待上传目录无裸文件夹
- [x] 更新类型注释中关于 `extraFolders` 的说明（反映其打入更新归档随热更新落盘，不再作为裸目录受限于单文件 25MB 限制）
