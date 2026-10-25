# 交接：electron-version-deployer-cli

> 写于 2026-10-19，2026-10-25 更新。上一会话在旧路径完成 0.6.0 的审查修复、发版和 CI 调整，之后项目整体迁到了本目录。

## 1. 迁移后先确认环境

- 旧路径 `~/Documents/project/duty/electron-version-deployer-cli` 已不存在，项目整体移到了 `/Volumes/onduty/duty/electron-version-deployer-cli`。
- git 状态：`main` 和 `origin/main` 都是 `4f8ee01`，工作区干净。被 gitignore 的本地文件（`CLAUDE.md`、`dist/`、`node_modules/`、`openspec/`、`.claude/`）也一起搬过来了。
- `/Volumes/onduty` 是外置的 APFS 磁盘映像，挂载参数 `nodev,nosuid,noowners`。
- **pnpm store 位置会对不上**。`node_modules/.modules.yaml` 里记录的 `storeDir` 是 `~/Library/pnpm/store/v3`，但在新位置执行 `pnpm store path` 得到的是 `/Volumes/onduty/.pnpm-store/v3`。预计下次 `pnpm install` 会报错或要求重装 node_modules（还没实测）。两种处理方式选一种：
  - `rm -rf node_modules && pnpm install --frozen-lockfile`：改用新卷上的 store；
  - `pnpm install --frozen-lockfile --store-dir ~/Library/pnpm/store/v3`：继续用旧 store。跨卷没法建硬链接，pnpm 会改成复制文件。
- **迁移后还没在新位置跑过测试**。命令见 `CLAUDE.md`：
  - `pnpm run typecheck`
  - `pnpm run test:unit`：18 个用例
  - `pnpm run test:e2e`：16 个场景，跑之前会先 build。上次机器负载很高时卡在场景 6，杀掉卡住的进程后重跑就过了。
- **项目记忆是按路径存的**，新路径下的 memory 是空的。旧记忆在 `~/.claude/projects/-Users-<用户名>-Documents-project-duty-electron-version-deployer-cli/memory/`，内容见第 5 节，建议写进新路径的记忆里。
- **单行 commit 规则的路径没覆盖新位置**。用户全局 `~/.claude/CLAUDE.md` 里「commit message 只能单行 subject」这条，只写了 `~/Documents/project/duty` 和 `~/Desktop/tmp` 两个路径。用户改规则之前，照样按单行 subject 提交。

## 2. 当前状态

- npm：`0.6.0` 是 `latest`，带 provenance，2026-10-16 由 CI 发布（run 38976566642）。
- 上一会话的提交如下，具体改动看 diff：
  - `9c745b6`：对抗审查发现的问题修复。包括远程缺 `version` 时误弹更新、下载失败后临时文件残留、`/Volumes` 下的路径被误判为只读；另外 `verify` 会拦截远程残留的分片清单，新增了 `onBeforeForceExit`，并把 `extraFolders` 标为破坏性变更。
  - `8017d17`：版本号改为 0.6.0，README 加升级指南。
  - `2130a8c`：typecheck 兼容 TS 5.0（加 `--emitDeclarationOnly false`）。
  - `b1b9d96`：CI 调整。pnpm 9.14.2 加 `--frozen-lockfile`，action 升到 node24 运行时的版本，runner 固定为 `ubuntu-24.04`，版本已发布时跳过 publish。lockfile 也重新生成了，解决 archiver `^7` 和 lockfile 不一致的问题。
  - `4f8ee01`：README 的 0.6.0 章节加了「更新日志」小节，内容和 `CHANGELOG.md` 逐字一致。
- 功能和行为以这些文件为准：`_CHANGELOG.md` 的 `[0.6.0]`、`_README.md`「0.6.0 版本说明与升级指南」、`docs/adr/0001-*`、`docs/adr/0002-*`、`GLOSSARY.md`。
- **README 和 CHANGELOG 已加下划线改名**，现在是 `_README.md`、`_CHANGELOG.md`。用户的决定是 npm 不显示更新日志。npm 和 GitHub 都只把 `README*` 当作说明文档，所以改名后 GitHub 仓库首页不再显示 README，npm 从下次发版起也不再显示（0.6.0 的页面保持原样）。用户知道这些后果，选择了这样做。`CHANGELOG.md` 本来就不在 npm 包里。不要为了显示更新日志单独发版，也不要把文件名改回去。
- 发版流程：
  1. 改 `package.json` 版本号、`_CHANGELOG.md`，以及 `_README.md` 顶部公告和对应版本章节；
  2. push 到 `main`；
  3. CI（`.github/workflows/main.yml`）跑完 typecheck、单测和 build 后自动 `npm publish`。版本已存在时跳过发布，只输出一条 notice。最近一次 run 38993891249 成功。

## 3. 待用户拍板或可选的事项（都没做）

1. **`npm pkg fix`**。发布时 npm 自动改了两处：`bin.evd` 从 `./dist/cli.cjs` 改成 `dist/cli.cjs`，`repository.url` 补上 `git+` 前缀。同时打出警告 `"bin[evd]" script name dist/cli.cjs was invalid and removed`。已核实不影响使用：registry 的 manifest 和 tarball 里都有 `bin`，实际装上 0.6.0 后 `.bin/evd` 也正常生成。想消掉这条警告，照这两处改 `package.json` 就行（`npm pkg fix` 还会顺便补上文件末尾的换行）。
2. **CI 用的 Node 20 已经停止维护**。job 还是 `node-version: '20'`，可以升到 22 或 24。升到 24 后可以考虑去掉 "Update npm" 这一步，但要注意两点：provenance 需要 npm ≥ 11.5.1；npm 12 要求 node ≥ 22.22.2。
3. **setup-node 的依赖缓存**。官方建议发布用的 workflow 关掉依赖缓存，防止缓存投毒，目前配的是 `cache: "pnpm"`。这个 workflow 只在 push `main` 时触发，风险不大。
4. **npm 关于 2FA token 的通知**。0.6.0 的发布日志里有一条 `npm tokens that bypass 2FA are being restricted for account changes and direct publishing`（https://gh.io/npm-gat-bypass2fa-deprecation）。CI 用的是 OIDC trusted publishing（`NODE_AUTH_TOKEN` 只是占位），不受影响。如果账号下还有本地手动发版用的、能绕过 2FA 的 token，需要按链接迁移。
5. **DEP0190 警告**。在 Node 26 下用 evd CLI 部署会出现 DEP0190，原因是 `child_process` 同时传了参数数组和 `shell: true`。位置在 `cli/commands/hostingProvider/Cloudflare.ts:40` 和 `cli/commands/hostingProvider/Netlify.ts:41`。
6. **openspec 有个变更没归档**。`openspec/changes/fix-webpack-template-path` 的 tasks 已经全部完成（6/6），但还没归档。它对应的模板内嵌功能已经随 0.6.0 发布。
7. **升级模拟中发现、还没处理的问题**：
   - **旧客户端升级后留下临时文件**。0.5.2 客户端执行完升级后，应用目录里会留下 `evdUnzip.zip`（模拟中有 17MB）、`evdUnzip/` 和 `_evdInstallerTmp.js`。0.6.0 只在 `installPkg` 结束时清理这几个路径（`src/main.ts:745` 起），启动时不清理，所以这些文件要等到下一次更新才会被删掉。
   - **只按版本号判断是否替换依赖**。安装器只替换版本号变了的依赖（`src/installer.js:165` 的 `shouldReplaceModule`）。版本号没变但内容变了的依赖，比如用 patch-package 打过补丁的，不会随更新下发。
   - **没测签名和公证**。模拟里用的是 `identity: null`，也没做公证。

## 4. 本地升级模拟环境

这套环境在临时目录里，可能已经被系统清理。用 `ls -d /private/tmp/claude-501/*electron-version-deployer-cli*/*/scratchpad/evd-upgrade-sim` 找它的位置。

- `host/server.mjs`：HTTPS 静态服务，用来模拟 Cloudflare Pages。默认端口 48765，可以用 `SIM_HOST_PORT` 改；证书在 `host/tls/`。它提供的是 `host/current-deployment` 指向的那次部署。
- `bin/wrangler`：假的 wrangler。执行 `pages deploy` 时，把目录复制到 `host/deployments/<id>`，然后切换指针。它会检查单文件 25 MiB 的上限，并且要求设置 `CLOUDFLARE_API_TOKEN`。
- `app-v1`：版本 1.0.0，用 evd 0.5.2 和 sqlite3 5.1.7。
- `app-v2`：版本 1.1.0，evd 用本地包 `evd-latest/electron-version-deployer-cli-0.6.0-local.0.tgz`，数据库换成 better-sqlite3 13.0.3。
- `installed/EvdSimApp.app`：v1 用 electron-builder `--dir` 打出的应用（`asar: false`、`identity: null`），已经热更新到 v2。
- `logs/`：每一步的日志，以及更新前后的状态 JSON。
- **结论**：因为 dependencies 有变化，0.5.2 客户端走了全量包，分 9 个分片下载，成功升级到 v2。better-sqlite3 能正常读出 sqlite3 写入的数据，evd 也被替换成了 0.6.0-local.0。
- 完整过程见旧会话记录：`~/.claude/projects/-Users-<用户名>-Documents-project-duty-electron-version-deployer-cli/22864e28-5f2a-4730-9eb9-b9a7d591a52c.jsonl`。

## 5. 用户偏好

以下两条来自旧路径的 memory，新路径下还没有：

- **待拍板的事项一次只问一条**。有多项需要用户决定时，用 AskUserQuestion 一次问一条（单选题，给出推荐项和 preview），全部问完再一起动手。版本号、提交方式这类执行细节也一样逐个确认。
- **兼容性只看上一个已发布版本**。评估客户端兼容性时，默认所有线上客户端都在「上一个已发布版本」上（下次发版时就是 0.6.0），不用考虑更老的版本。

其余偏好写在 `~/.claude/CLAUDE.md` 里，会自动加载，包括单行 commit、不加 attribution、注释和日志的规则、高风险操作先给方案。

## 6. Suggested skills

- `gitpush`：提交并推送。subject 写成单行中文 conventional commit，不写 body 和 trailer。只 add 明确列出的路径。
- `unai`：交付代码改动前，清理 AI 味的注释和调试日志。
- `update-version-and-build`：如果要发 0.6.1，用它改版本号并构建。
- `domain-modeling`：改动强制更新、分片这类领域语义，或者要更新 ADR、`GLOSSARY.md` 时用。
- `openspec-archive-change`（或 `/opsx:archive`）：归档 `fix-webpack-template-path`。
- `handoff`：会话结束前再写一份交接。
