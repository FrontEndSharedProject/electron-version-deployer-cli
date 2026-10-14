# 01: 部署阶段最低支持版本（Minimum Supported Version）解析、写入与远程生效校验（Remote Verification）

**What to build:** 遵循 ADR-0002，支持应用发布者与 CI/CD 在部署配置中声明 `minSupportedVersion?: string`，并在部署与**预部署检测（Pre-deploy Check）**命令中通过 CLI 参数覆盖。在打包准备与部署整形阶段，把最终生效值写入待上传的**远程版本元数据（Remote Version Metadata）**，保证**全量更新包（Full Package）**与**增量更新包（Logic Package）**内的应用自身 `package.json` 保持纯净。预部署检测在生效值低于远程现值时走门禁，**远程生效校验（Remote Verification）**比对远程与本地待上传元数据的最低支持版本是否一致。

**Blocked by:** None (can start immediately)

**前置:** 工作区中未提交的改动（含 `test/unit-and-installer.test.ts` 测试脚手架）需先提交为基线，worktree 中的 agent 才能拿到。

**Status:** ready-for-agent

## 与 02 共享的约定

- 远程版本元数据即待上传目录中的 `node_modules/.evd/package.json`，也就是客户端拉取的远程 `package.json`。
- 最低支持版本写在其顶层可选字段 `minSupportedVersion`，格式严格匹配 `^\d+\.\d+\.\d+$`（`versionToNum` 不支持预发布后缀）；未声明时不写该键。

## 生效值解析

- CLI 参数（仅 `deploy` 与 `preDeploy`）：
  - `--min-supported-version <version>`：显式指定。
  - `--force-update`：简写，取本次待部署版本（`.evd/package.json` 的 `version`）。
  - `--no-force-update`：本次不声明，忽略配置值。
  - 三者互斥，同时出现直接报错。
- 优先级：CLI > 配置 > 未声明。
- `preDeploy` 现有的 `--force`（放行全部 `--allow-*`）不包含 `--force-update`，也不写入任何最低支持版本。

## 预部署检测

- 格式非法或高于本次部署版本时报错（高于会让更新到最新版的客户端仍低于下限，陷入强制更新循环）。
- 远程现有 `minSupportedVersion` 高于本次生效值（含生效值为未声明）时：
  - 生效值来自显式 CLI 参数，视为已确认；
  - 生效值来自配置或未声明：交互模式弹确认，非交互模式需 `--allow-min-version-downgrade`；`--force` 包含此项。
- 修改已发布同一版本的最低支持版本属于同版本覆盖部署，沿用现有 `--allow-same-version` 门禁，不另设豁免。
- `deploy` 与 `preDeploy` 打印最终生效值及来源（CLI / 配置 / 未声明）；交互式 `deploy` 在生效值存在时二次确认「低于 x.y.z 的客户端将被强制更新」。

## 代码入口

- 配置：`src/types/EVDConfigType.ts`、`public/templates/evd.config.ts`（以注释示例给出）
- 写入：`cli/commands/prepare.ts` 的 `copySourceAndZipFiles`（归档在拷贝 `package.json` 之前完成，保持该顺序）；`cli/commands/deploy.ts`、`cli/commands/preDeploy.ts` 在检测通过后、拆分与上传前重写
- CLI 覆盖配置的先例：`cli/helpers/zipSplit.ts` 的 `resolveZipSplitOptions` 与 `--split/--no-split`。commander 需先定义 `--force-update` 再定义 `--no-force-update`，未传时值才为 `undefined`
- 门禁：`cli/helpers/deployChecks.ts` 的 `gate`、`validateRemotePackageJSON`、`createCheckPolicy`
- 校验：`cli/commands/verify.ts` 的 `runChecks`

## 验收

- [ ] 部署配置类型与模板支持可选字段 `minSupportedVersion?: string`
- [ ] `deploy` 与 `preDeploy` 支持 `--min-supported-version <version>`、`--force-update`、`--no-force-update`，三者互斥，优先级 CLI > 配置；`preDeploy --force` 不触发写入
- [ ] `prepare` 按配置值写入 `.evd/package.json`；`deploy` / `preDeploy` 按最终生效值重写，生效值为未声明时删除该键；同一份产物带不同参数反复整形结果幂等；源 `sources.packageJSON` 与两个 zip 内的 `package.json` 均不含该字段
- [ ] 格式非法、高于本次部署版本、互斥参数同时出现时报错并以非零状态退出
- [ ] 生效值低于远程现值且非显式 CLI 参数时，交互模式确认、非交互模式需 `--allow-min-version-downgrade`（`--force` 包含）；同版本修改沿用 `--allow-same-version`
- [ ] `deploy` / `preDeploy` 打印最终生效值及来源；交互式 `deploy` 在生效值存在时二次确认
- [ ] `verify` 比对 `remote.minSupportedVersion ?? null` 与本地值，不一致时输出「最低支持版本不一致，远程 X，本地 Y」，计入失败项、参与 `--retry`，最终以非零状态退出
- [ ] 单元与集成测试覆盖：参数优先级与互斥、格式与上限校验、降级门禁、写入幂等与归档纯净、远程校验一致性
- [ ] README 补充配置项、三个 CLI 参数、`--allow-min-version-downgrade`、CI 示例，并说明不支持该字段的旧客户端会忽略它
