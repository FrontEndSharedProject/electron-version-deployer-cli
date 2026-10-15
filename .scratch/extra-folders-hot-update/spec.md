# Extra Folders 客户端热更新与双包分片支持

**Status:** done

## Problem Statement

当前发布配置中的额外文件夹（`extraFolders`）仅在部署阶段与**预部署检测（Pre-deploy Check）**阶段以未压缩裸文件夹的形式直接复制到待上传目录中，存在两个核心问题：

1. **无法随客户端热更新落盘**：`extraFolders` 并未打入**全量更新包（Full Package）**或**增量更新包（Logic Package）**，客户端执行热更新时只会下载并解压上述两个更新包，导致 `extraFolders` 中的资源或目录无法热更新到客户端本地应用目录。
2. **受限于 Cloudflare Pages 25MB 单文件体积上限**：一方面，未压缩的裸文件夹中一旦包含超过 25MB 的文件，Cloudflare Pages 会直接拒绝上传；另一方面，如果把 `extraFolders` 打入**增量更新包（Logic Package）**使其体积超过 25MB，当前**分片更新包（Split Package）**机制仅对**全量更新包（Full Package）**生效，未对**增量更新包（Logic Package）**进行分片，同样会在 Cloudflare Pages 部署时触发 25MB 限制，且客户端也无法拉取分片后的增量更新包。

## Solution

将 `extraFolders` 从“远程静态裸目录复制”升级为“客户端热更新归档的一部分”，并让**全量更新包（Full Package）**与**增量更新包（Logic Package）**统一具备按阈值自动切分为**分片更新包（Split Package）**的能力：

1. **打包阶段并入双更新包**：在打包准备阶段解析并校验 `extraFolders`（支持字符串数组、同步函数与异步函数，兼容相对项目根目录路径与绝对路径），将其与业务代码一同打入**全量更新包（Full Package）**与**增量更新包（Logic Package）**的根层级（`<basename>/...`）；部署与**预部署检测（Pre-deploy Check）**阶段不再向待上传目录复制未压缩的裸文件夹。
2. **双包统一自动分片**：复用现有的分片配置（默认在 Cloudflare 下开启，24MB 阈值、20MB 切片）及 CLI `--split` / `--no-split` 参数，对**全量更新包（Full Package）**与**增量更新包（Logic Package）**分别按各自体积独立判断是否超出阈值；超出时自动切分为各自的**分片更新包（Split Package）**目录与索引清单，并删除原整包文件，彻底规避 Cloudflare Pages 的 25MB 单文件限制。
3. **远程生效校验覆盖双包分片**：**远程生效校验（Remote Verification）**根据本地待上传目录中**增量更新包（Logic Package）**与**全量更新包（Full Package）**的实际形态（整包或**分片更新包（Split Package）**），自动探测并校验远程对应的整包或全部分片。
4. **客户端支持增量更新包分片拉取与覆盖安装**：客户端无论下载**全量更新包（Full Package）**还是**增量更新包（Logic Package）**，均先探测对应**分片更新包（Split Package）**的索引清单；若存在分片则按序下载并合并为完整归档，解压后由安装子进程将 `<basename>` 目录递归覆盖写入客户端 `app.getAppPath()/<basename>`（同名文件覆盖、新增文件写入）。

## User Stories

1. As an 应用发布者, I want 在配置中通过静态字符串数组声明 `extraFolders`, so that 打包准备阶段自动将这些目录打入**全量更新包（Full Package）**与**增量更新包（Logic Package）**。
2. As an 应用发布者, I want 在配置中通过同步函数或异步函数动态返回 `extraFolders` 列表, so that 我可以根据编译产物动态决定需要随热更新下发的额外文件夹。
3. As an 应用发布者, I want `extraFolders` 在应用编译完成后再执行解析与打包, so that 编译阶段动态生成的额外目录能够被正确读取并打入更新包。
4. As an 应用发布者, I want `extraFolders` 同时支持相对项目根目录的相对路径与绝对路径, so that 不同类型的构建脚本都能灵活指定目录位置。
5. As an 应用发布者, I want 当 `extraFolders` 中存在不存在的路径或非文件夹路径时立即报错并终止准备流程, so that 我不会发布缺失资源的更新包。
6. As an 应用发布者, I want 当 `extraFolders` 中存在同名目录（`basename` 重复）或与业务代码目录、依赖目录、`package.json` 名称冲突时立即报错并终止准备流程, so that 更新包内的顶层目录结构不会发生隐式互相覆盖。
7. As an 应用发布者, I want 待上传目录中不再保留未压缩的 `extraFolders` 裸文件夹, so that 不会因为裸文件超过 25MB 导致 Cloudflare Pages 部署失败，也不会占用双倍上传体积。
8. As an 使用 Cloudflare Pages 的发布者, I want 当并入 `extraFolders` 后的**增量更新包（Logic Package）**体积达到或超过分片阈值（默认 24MB）时自动按分片大小（默认 20MB）切分为**分片更新包（Split Package）**, so that 即使依赖未变但额外资源较大时也能顺利通过 Cloudflare Pages 的 25MB 单文件限制。
9. As an 使用 Cloudflare Pages 的发布者, I want **全量更新包（Full Package）**与**增量更新包（Logic Package）**共用同一套分片配置（`enabled`、`thresholdMB`、`chunkSizeMB`）与 CLI `--split` / `--no-split` 参数但按各自实际体积独立判断是否拆分, so that 我无需维护两套分片参数。
10. As an CI/CD 维护者, I want 在已拆分的待上传目录上重复执行部署或**预部署检测（Pre-deploy Check）**时保持幂等跳过，而在已拆分状态下传入 `--no-split` 时明确报错提示重新准备, so that 构建流水线行为可预期且不会上传残缺产物。
11. As an CI/CD 维护者, I want 当关闭分片或本次包体积未达分片阈值时自动清理待上传目录中残留的历史**分片更新包（Split Package）**目录, so that 客户端不会误读旧版本的残留分片索引。
12. As an CI/CD 维护者, I want 执行**远程生效校验（Remote Verification）**时自动识别本地**增量更新包（Logic Package）**与**全量更新包（Full Package）**是整包还是**分片更新包（Split Package）**并逐一校验远程可达性, so that 无论哪种包触发了分片都能确保线上文件完整生效。
13. As an 终端用户, I want 客户端在执行**增量更新包（Logic Package）**更新时能够自动探测远程是否存在对应的**分片更新包（Split Package）**索引并按序下载合并分片, so that 超过 24MB 的增量更新包也能正常完成下载与解压。
14. As an 终端用户, I want 客户端在下载**增量更新包（Logic Package）**分片时在更新弹窗中看到与全量分片一致的分片进度（如 `分片 x/n` 与体积进度）, so that 大体积增量更新期间有清晰的进度反馈。
15. As an 终端用户, I want 客户端解压更新包后将 `extraFolders` 对应的顶层目录递归覆盖写入本地 `app.getAppPath()/<basename>`（同名文件覆盖、新增文件创建，不删除本地旧目录）, so that 热更新完成后应用即可读取最新的额外目录资源，且不会在 Windows 下因目录删除锁句柄而失败。

## Implementation Decisions

- **职责迁移与执行时机**：
  - `extraFolders` 的解析、校验与归档从部署检测阶段迁移至打包准备阶段（在应用编译命令与更新日志生成完成后、生成两个压缩包之前执行）。
  - 部署与**预部署检测（Pre-deploy Check）**阶段移除将 `extraFolders` 直接复制为待上传目录裸文件夹的逻辑；若待上传目录中存在与本次 `extraFolders` 同名的历史遗留裸目录，在准备阶段予以清理。
- **路径解析与冲突校验契约**：
  - `extraFolders` 支持 `string[]`、`() => string[]`、`() => Promise<string[]>`；未配置或返回空数组时视为无额外文件夹。
  - 每个条目基于项目根目录解析（同时兼容相对路径与绝对路径），必须存在且为目录。
  - 每个条目的目标顶层目录名取其 `basename`；若多个条目 `basename` 重复，或与业务代码目录名、依赖目录名、`package.json` 冲突，直接抛出明确错误并终止。
- **归档结构**：
  - **全量更新包（Full Package）**包含：依赖目录、业务代码目录、`package.json` 以及全部解析后的 `extraFolders` 目录。
  - **增量更新包（Logic Package）**包含：业务代码目录、`package.json` 以及全部解析后的 `extraFolders` 目录。
- **双包统一分片协议**：
  - **全量更新包（Full Package）**（`fullCode.zip`）与**增量更新包（Logic Package）**（`logicCode.zip`）共用同一套分片选项（`enabled`、`thresholdMB` 默认 24、`chunkSizeMB` 默认 20）及 `--split` / `--no-split` CLI 覆盖参数。
  - 分片目录与文件命名规则对称：
    - 全量包分片目录为 `fullCodeZipSplitZips`，分片文件名为 `fullCode.part1.zip`、`fullCode.part2.zip`…，清单为 `fullCodeZipSplitZips/index.json`。
    - 增量包分片目录为 `logicCodeZipSplitZips`，分片文件名为 `logicCode.part1.zip`、`logicCode.part2.zip`…，清单为 `logicCodeZipSplitZips/index.json`。
  - 对每个更新包独立执行分片判定：
    - 当 `enabled: false` 时，若该包已处于已拆分且原包已删除状态，则抛错提示重新执行打包准备；否则清理该包残留的分片目录。
    - 当 `enabled: true` 时，若该包已处于已拆分状态则幂等跳过；若整包体积小于 `thresholdMB`，清理残留分片目录并保留整包文件；若整包体积大于或等于 `thresholdMB`，创建分片目录、写入各分片与 `index.json` 并删除原整包文件。
- **远程生效校验规则**：
  - 对**增量更新包（Logic Package）**与**全量更新包（Full Package）**采用统一的分片/整包分支探测：若本地待上传目录中存在对应包的 `<splitFolder>/index.json`，则请求远程 `<splitFolder>/index.json` 并逐个校验分片文件；否则直接校验远程 `<zipName>` 整包文件。
- **客户端分片探测、合并与覆盖安装**：
  - 客户端在安装阶段根据目标文件名（`fullCode.zip` 或 `logicCode.zip`）映射到对应的远程分片目录（`fullCodeZipSplitZips` 或 `logicCodeZipSplitZips`），先请求 `<splitFolder>/index.json`。
  - 若远程返回非空数组分片清单，则按序下载各分片至临时文件、流式合并为本地目标 zip 并在 `finally` 中清理临时分片文件；若远程无分片清单（如未超过阈值或 404），则直接下载整包 `<zipName>`。
  - 解压后交由现有的独立安装子进程处理：子进程遍历解压目录顶层条目，非 `node_modules` 的目录（包括业务代码目录与所有 `extraFolders` 目录）统一递归创建缺失子目录并覆盖同名文件、写入新增文件到 `app.getAppPath()/<basename>`。

## Testing Decisions

- **好测试的标准**：只测试模块的外部可观测行为（生成的 zip 包内部条目结构、待上传目录中的分片文件与 `index.json`、异常输入下的报错信息、客户端端到端更新后的本地落盘文件内容），不断言内部私有函数调用细节。
- **被测模块与现有测试接缝**：
  1. **CLI 准备、分片与远程生效校验测试**（沿用现有单元与集成测试套件）：
     - 通过打包准备入口验证 `extraFolders`（数组、同步/异步函数、相对/绝对路径）被同时打入**全量更新包（Full Package）**与**增量更新包（Logic Package）**，且待上传目录根部不生成裸文件夹；验证路径不存在、非目录、重名或名称冲突时的报错。
     - 通过分片处理入口验证 `fullCode.zip` 与 `logicCode.zip` 在低于/高于阈值、`--split` / `--no-split`、重复执行幂等、已拆分后关闭分片报错等场景下的行为。
     - 通过**远程生效校验（Remote Verification）**入口验证当 `logicCode.zip` 被拆分为 `logicCodeZipSplitZips` 时，校验器能正确校验远程增量分片索引及各分片文件。
  2. **客户端 Electron 端到端测试**（沿用现有 Electron E2E 测试套件与本地 Mock 更新服务器）：
     - 构造依赖未变更（触发下载**增量更新包（Logic Package）**）、包含 `extraFolders` 且远程 `logicCode.zip` 已拆分为 `logicCodeZipSplitZips` 多个分片的端到端更新场景，验证客户端完成分片下载、合并、解压与子进程安装后，`app.getAppPath()/<basename>` 下的原有文件被更新、新增嵌套文件被写入、原本存在的历史冗余文件未被误删。

## Out of Scope

- 不对 `extraFolders` 做独立于更新包之外的内容哈希比对与单独归档下载。
- 不在客户端安装阶段清空或删除本地 `app.getAppPath()/<basename>` 中旧版本遗留的文件。
- 不再支持将 `extraFolders` 作为未压缩静态目录裸露托管在远程服务器根路径下。
- 不支持将 `extraFolders` 解压安装到 `app.getAppPath()` 以外的任意自定义系统路径。

## Further Notes

- 需同步更新术语表（`GLOSSARY.md` 中**分片更新包（Split Package）**的定义扩展为涵盖全量更新包与增量更新包）与 `README.md` 中关于 `extraFolders` 及 `zipSplit` / `--split` 的文档说明。
