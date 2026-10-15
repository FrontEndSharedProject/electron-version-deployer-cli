const {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const archiver = require("archiver");

const REPO_ROOT = resolve(__dirname, "..");
const ELECTRON_BIN = join(REPO_ROOT, "node_modules", ".bin", "electron");
const DIST_MAIN = join(REPO_ROOT, "dist", "main.js");

function assertOk(cond, msg = "Assertion failed") {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      msg ||
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

/**
 * 使用 archiver 创建一个真实的更新 zip 包
 */
function createUpdateZip(zipFilePath, filesMap) {
  return new Promise((resolveZip, rejectZip) => {
    const output = createWriteStream(zipFilePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolveZip());
    output.on("error", rejectZip);
    archive.on("error", rejectZip);

    archive.pipe(output);
    for (const [relPath, content] of Object.entries(filesMap)) {
      archive.append(content, { name: relPath });
    }
    archive.finalize();
  });
}

/**
 * 启动本地 HTTP 更新服务器
 */
function startMockUpdateServer(zipPath, remotePkg, options = {}) {
  return new Promise((resolveServer) => {
    let currentRemotePkg = remotePkg;
    const getActiveRemotePkg = () => {
      if (
        options.remotePkgFilePath &&
        existsSync(options.remotePkgFilePath)
      ) {
        try {
          return JSON.parse(readFileSync(options.remotePkgFilePath, "utf-8"));
        } catch (_) {}
      }
      return currentRemotePkg;
    };
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || "").split("?")[0];
      const activePkg = getActiveRemotePkg();
      if (urlPath === "/package.json") {
        const body = JSON.stringify(activePkg);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      if (urlPath === "/changelog.json") {
        const body = JSON.stringify([
          {
            version: activePkg.version,
            date: "2026-10-14",
            body: "<ul><li>新增全流程更新进度与错误诊断提示</li></ul>",
          },
        ]);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      if (urlPath === "/logicCode.zip" || urlPath === "/fullCode.zip") {
        const sendZip = () => {
          const buf = readFileSync(zipPath);
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Length": buf.length,
          });
          res.end(buf);
        };
        if (options.downloadDelayMs > 0) {
          setTimeout(sendZip, options.downloadDelayMs);
        } else {
          sendZip();
        }
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveServer({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        setRemotePkg(nextPkg) {
          currentRemotePkg = nextPkg;
        },
      });
    });
  });
}

/**
 * 启动一个真实的临时 Electron 应用实例并运行指定场景
 */
function runElectronScenario(scenarioName, setupOptions) {
  return new Promise(async (resolveScenario, rejectScenario) => {
    const tempBase = mkdtempSync(join(tmpdir(), `evd-e2e-${scenarioName}-`));
    const appDir = join(tempBase, "mock-app");
    const serverAssetsDir = join(tempBase, "server-assets");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(serverAssetsDir, { recursive: true });

    const zipPath = join(serverAssetsDir, "logicCode.zip");
    const remotePkg = {
      name: "mock-evd-app",
      version: "2.0.0",
      dependencies: { foo: "1.0.0" },
      ...(setupOptions.remotePkgOverrides || {}),
    };
    const remotePkgFilePath = join(tempBase, "remote-pkg.json");
    writeFileSync(remotePkgFilePath, JSON.stringify(remotePkg, null, 2), "utf-8");

    await createUpdateZip(zipPath, {
      "package.json": JSON.stringify(remotePkg, null, 2),
      "src/featureA.js": "module.exports = 'featureA v2.0.0';\n",
      "src/featureB.js": "module.exports = 'featureB v2.0.0';\n",
      "locked-module.js": "module.exports = 'updated locked module v2.0.0';\n",
      ...(setupOptions.extraZipEntries || {}),
    });

    const { server, url: remoteUrl } = await startMockUpdateServer(
      zipPath,
      remotePkg,
      {
        downloadDelayMs: setupOptions.downloadDelayMs || 0,
        remotePkgFilePath,
      }
    );

    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify(
        {
          name: "mock-evd-app",
          version: setupOptions.localVersion || "1.0.0",
          main: "main.cjs",
          dependencies: { foo: "1.0.0" },
        },
        null,
        2
      ),
      "utf-8"
    );
    writeFileSync(
      join(appDir, "locked-module.js"),
      "module.exports = 'old v1.0.0';\n",
      "utf-8"
    );

    if (setupOptions.initialAppFiles) {
      for (const [relPath, content] of Object.entries(
        setupOptions.initialAppFiles
      )) {
        const fullPath = join(appDir, relPath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, "utf-8");
      }
    }

    if (setupOptions.lockTargetFile) {
      chmodSync(join(appDir, "locked-module.js"), 0o444);
    }

    if (typeof setupOptions.nodeModulesTemplateHtml === "string") {
      const nmTemplateDir = join(
        appDir,
        "node_modules",
        "electron-version-deployer-cli",
        "dist",
        "templates"
      );
      mkdirSync(nmTemplateDir, { recursive: true });
      writeFileSync(
        join(nmTemplateDir, "newVersionDialog.html"),
        setupOptions.nodeModulesTemplateHtml,
        "utf-8"
      );
    }

    const resultJsonPath = join(tempBase, "result.json");

    // 构造 Electron 主进程入口脚本
    const mainScript = `
const { app, BrowserWindow } = require("electron");
const { writeFileSync, chmodSync } = require("node:fs");
const { EVDInit, EVDCheckUpdate } = require(${JSON.stringify(DIST_MAIN)});

const RESULT_PATH = ${JSON.stringify(resultJsonPath)};
const REMOTE_URL = ${JSON.stringify(remoteUrl)};
const REMOTE_PKG_FILE_PATH = ${JSON.stringify(remotePkgFilePath)};
const MAKE_APP_DIR_READONLY = ${JSON.stringify(
      !!setupOptions.makeAppDirReadonly
    )};
const STUB_WIN_CLOSE = ${JSON.stringify(setupOptions.stubWinClose !== false)};
const APP_DIR = ${JSON.stringify(appDir)};

function setRemotePkg(overrides = {}) {
  const nextPkg = {
    name: "mock-evd-app",
    version: "2.0.0",
    dependencies: { foo: "1.0.0" },
    ...overrides,
  };
  writeFileSync(REMOTE_PKG_FILE_PATH, JSON.stringify(nextPkg, null, 2), "utf-8");
}

let capturedOnError = null;
let relaunchCalled = false;
let exitIntercepted = false;
const exitCalls = [];
const lifecycleOrder = [];
let onBeforeInstallHook = null;
let lastFocusedWindow = null;
const focusHistory = [];

const origExit = app.exit.bind(app);
const origHide = BrowserWindow.prototype.hide;
const origSetSkipTaskbar = BrowserWindow.prototype.setSkipTaskbar;
const origSetEnabled = BrowserWindow.prototype.setEnabled;

app.relaunch = () => {
  relaunchCalled = true;
  lifecycleOrder.push("relaunch");
};
app.exit = (code) => {
  exitIntercepted = true;
  exitCalls.push(code);
  lifecycleOrder.push("exit:" + String(code));
};
// 静默窗口展示，避免自动化测试期间弹窗闪烁，同时记录可见性与焦点状态并派发事件
BrowserWindow.prototype.show = function () {
  this.__testVisible = true;
  this.__testShowCalls = (this.__testShowCalls || 0) + 1;
  this.emit("show");
};
BrowserWindow.prototype.showInactive = function () {
  this.__testVisible = true;
  this.__testShowInactiveCalls = (this.__testShowInactiveCalls || 0) + 1;
  this.emit("show");
};
BrowserWindow.prototype.hide = function () {
  this.__testVisible = false;
  this.__testHideCalls = (this.__testHideCalls || 0) + 1;
  if (typeof origHide === "function") {
    origHide.call(this);
  }
  this.emit("hide");
};
BrowserWindow.prototype.isVisible = function () {
  return Boolean(this.__testVisible);
};
BrowserWindow.prototype.focus = function () {
  this.__testFocusCalls = (this.__testFocusCalls || 0) + 1;
  lastFocusedWindow = this;
  focusHistory.push(this.id);
};
BrowserWindow.prototype.setSkipTaskbar = function (skip) {
  this.__testSkipTaskbar = Boolean(skip);
  this.__testSkipTaskbarCalls = this.__testSkipTaskbarCalls || [];
  this.__testSkipTaskbarCalls.push(Boolean(skip));
  if (typeof origSetSkipTaskbar === "function") {
    origSetSkipTaskbar.call(this, skip);
  }
};
BrowserWindow.prototype.setEnabled = function (enable) {
  this.__testEnabled = Boolean(enable);
  this.__testSetEnabledCalls = this.__testSetEnabledCalls || [];
  this.__testSetEnabledCalls.push(Boolean(enable));
  if (typeof origSetEnabled === "function") {
    origSetEnabled.call(this, enable);
  }
};
BrowserWindow.prototype.isEnabled = function () {
  return this.__testEnabled === undefined ? true : Boolean(this.__testEnabled);
};
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  try {
    EVDInit({
      remoteUrl: REMOTE_URL,
      detectAtStart: false,
      onBeforeNewPkgInstall(next, version) {
        if (typeof onBeforeInstallHook === "function") {
          onBeforeInstallHook(next, version);
        } else {
          next();
        }
      },
      onError(err) {
        capturedOnError = {
          code: err.code,
          phase: err.phase,
          stage: err.stage,
          progress: err.progress,
          filePath: err.filePath,
          message: err.message,
        };
      },
    });

    if (MAKE_APP_DIR_READONLY) {
      chmodSync(APP_DIR, 0o555);
    }

    ${setupOptions.beforeInitialCheckScript || ""}

    const hasUpdate = await EVDCheckUpdate();

    // 等待弹窗 BrowserWindow 创建且页面 DOM 完全加载就绪
    const waitForDialogReady = () =>
      new Promise((res, rej) => {
        const deadline = Date.now() + 10000;
        const check = async () => {
          if (Date.now() > deadline) {
            rej(new Error("Timed out waiting for dialog window to load"));
            return;
          }
          const wins = BrowserWindow.getAllWindows();
          for (const win of wins) {
            if (win.__isTestHostWin || win.isDestroyed()) continue;
            try {
              const ready = await win.webContents.executeJavaScript(
                "Boolean(document.querySelector('#updateBtn') && document.querySelector('#stagePercent'))"
              );
              if (ready) {
                if (!win.__origClose) {
                  win.__origClose = win.close.bind(win);
                }
                if (STUB_WIN_CLOSE) {
                  // 阻止成功更新后 1ms 自动关闭销毁窗口，以便读取最终 DOM 状态
                  win.close = () => {};
                }
                res(win);
                return;
              }
            } catch (_) {}
          }
          setTimeout(check, 50);
        };
        check();
      });

    const dialogWin = await waitForDialogReady();
    await new Promise((r) => setTimeout(r, 80));

    ${setupOptions.customActionScript || ""}

    if (${JSON.stringify(!!setupOptions.inspectInitialOnly)}) {
      const initialSnapshot = await dialogWin.webContents.executeJavaScript(\`({
        documentTitle: document.title,
        headerText: document.querySelector(".title-bar span")?.textContent || "",
        skipBtnText: document.querySelector("#skipBtn")?.textContent || "",
        closeBtnText: document.querySelector("#closeBtn")?.textContent || "",
        retryBtnText: document.querySelector("#retryBtn")?.textContent || "",
        copyErrorBtnText: document.querySelector("#copyErrorBtn")?.textContent || "",
        templateVersionMeta: document.querySelector('meta[name="evd-template-version"]')?.getAttribute("content") || null,
        bodyLocalMarker: document.body.getAttribute("data-local-template") || null,
      })\`);
      initialSnapshot.windowTitle = dialogWin.getTitle();
      initialSnapshot.loadedUrl = dialogWin.webContents.getURL();
      writeFileSync(
        RESULT_PATH,
        JSON.stringify(
          {
            hasUpdate,
            relaunchCalled,
            exitIntercepted,
            exitCalls,
            lifecycleOrder,
            capturedOnError,
            domSnapshot: initialSnapshot,
          },
          null,
          2
        ),
        "utf-8"
      );
      setTimeout(() => origExit(0), 50);
      return;
    }

    // 在渲染进程注入监听器收集所有 evd-update-progress 与 evd-update-error 事件，然后触发 #updateBtn 点击
    await dialogWin.webContents.executeJavaScript(\`
      (() => {
        window.__testProgressEvents = [];
        window.__testErrorEvents = [];
        const ipc = require("electron").ipcRenderer;
        ipc.on("evd-update-progress", (_, payload) => {
          window.__testProgressEvents.push(payload);
        });
        ipc.on("evd-update-error", (_, payload) => {
          window.__testErrorEvents.push(payload);
        });
        document.querySelector("#updateBtn").click();
      })();
    \`);

    // 轮询等待完成（relaunch 阶段到达）或错误视图显示
    const waitForFinish = () =>
      new Promise((res, rej) => {
        const deadline = Date.now() + 15000;
        const poll = async () => {
          if (Date.now() > deadline) {
            rej(new Error("Timed out waiting for update scenario to finish"));
            return;
          }
          try {
            const snapshot = await dialogWin.webContents.executeJavaScript(\`({
              progressEvents: window.__testProgressEvents,
              errorEvents: window.__testErrorEvents,
              documentTitle: document.title,
              headerText: document.querySelector(".title-bar span").textContent,
              skipBtnText: document.querySelector("#skipBtn").textContent,
              closeBtnText: document.querySelector("#closeBtn").textContent,
              retryBtnText: document.querySelector("#retryBtn").textContent,
              copyErrorBtnText: document.querySelector("#copyErrorBtn").textContent,
              loadingDisplay: document.querySelector(".loading-box").style.display,
              errorDisplay: document.querySelector(".error-box").style.display,
              stageTitle: document.querySelector("#stageTitle").textContent,
              stagePercent: document.querySelector("#stagePercent").textContent,
              currentFileBox: document.querySelector("#currentFileBox").textContent,
              stepValues: {
                precheck: document.querySelector("#val-precheck").textContent,
                download: document.querySelector("#val-download").textContent,
                unzip: document.querySelector("#val-unzip").textContent,
                install: document.querySelector("#val-install").textContent,
                relaunch: document.querySelector("#val-relaunch").textContent,
              },
              errorMessage: document.querySelector(".error-message").textContent,
              errorCode: document.querySelector(".error-code").textContent,
              errorDetail: document.querySelector(".error-detail").textContent,
            })\`);
            snapshot.windowTitle = dialogWin.getTitle();

            const reachedRelaunch = snapshot.progressEvents.some(
              (e) => e.stage === "relaunch"
            );
            if (reachedRelaunch || snapshot.errorDisplay === "flex") {
              res(snapshot);
              return;
            }
          } catch (e) {}
          setTimeout(poll, 60);
        };
        poll();
      });

    const domSnapshot = await waitForFinish();

    if (MAKE_APP_DIR_READONLY) {
      try {
        chmodSync(APP_DIR, 0o755);
      } catch (_) {}
    }

    writeFileSync(
      RESULT_PATH,
      JSON.stringify(
        {
          hasUpdate,
          relaunchCalled,
          exitIntercepted,
          exitCalls,
          lifecycleOrder,
          capturedOnError,
          domSnapshot,
        },
        null,
        2
      ),
      "utf-8"
    );

    setTimeout(() => origExit(0), 50);
  } catch (err) {
    console.error("E2E Main Process Error:", err);
    if (MAKE_APP_DIR_READONLY) {
      try {
        chmodSync(APP_DIR, 0o755);
      } catch (_) {}
    }
    origExit(1);
  }
});
`;

    writeFileSync(join(appDir, "main.cjs"), mainScript, "utf-8");

    const child = spawn(ELECTRON_BIN, [appDir], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_PATH: join(REPO_ROOT, "node_modules"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("exit", (code) => {
      server.close();
      try {
        chmodSync(appDir, 0o755);
        chmodSync(join(appDir, "locked-module.js"), 0o644);
      } catch (_) {}

      try {
        if (!existsSync(resultJsonPath)) {
          rejectScenario(
            new Error(
              `Electron exited (code=${code}) without writing result.json. stderr:\n${stderr}`
            )
          );
          return;
        }
        const result = JSON.parse(readFileSync(resultJsonPath, "utf-8"));
        const updatedPkgAfter = JSON.parse(
          readFileSync(join(appDir, "package.json"), "utf-8")
        );
        const featureAAfter = existsSync(join(appDir, "src/featureA.js"))
          ? readFileSync(join(appDir, "src/featureA.js"), "utf-8")
          : null;
        const appFilesAfter = {};
        if (Array.isArray(setupOptions.readAppFiles)) {
          for (const relPath of setupOptions.readAppFiles) {
            const fullPath = join(appDir, relPath);
            appFilesAfter[relPath] = existsSync(fullPath)
              ? readFileSync(fullPath, "utf-8")
              : null;
          }
        }
        resolveScenario({
          result,
          updatedPkgAfter,
          featureAAfter,
          appFilesAfter,
          appDir,
        });
      } catch (err) {
        rejectScenario(err);
      } finally {
        rmSync(tempBase, { recursive: true, force: true });
      }
    });
  });
}

async function main() {
  console.log("=== 3. Electron 全链路端到端 (E2E) 自动化测试 ===");

  // 场景 1：完整成功更新流程
  {
    const start = Date.now();
    const { result, updatedPkgAfter, featureAAfter } =
      await runElectronScenario("success", {});
    assertEqual(result.hasUpdate, true);
    assertEqual(result.capturedOnError, null);
    assertEqual(
      updatedPkgAfter.version,
      "2.0.0",
      "package.json 应被更新为 2.0.0"
    );
    assertEqual(
      featureAAfter,
      "module.exports = 'featureA v2.0.0';\n",
      "新文件 src/featureA.js 应成功写入"
    );

    const stagesSeen = new Set(
      result.domSnapshot.progressEvents.map((e) => e.stage)
    );
    for (const expectedStage of [
      "precheck",
      "download",
      "unzip",
      "install",
      "relaunch",
    ]) {
      assertOk(
        stagesSeen.has(expectedStage),
        `应收到阶段 ${expectedStage} 的进度事件，实际收到: ${[
          ...stagesSeen,
        ].join(",")}`
      );
    }

    assertEqual(result.domSnapshot.stagePercent, "100%");
    assertOk(
      result.domSnapshot.stepValues.precheck.includes("通过"),
      `precheck 状态异常: ${result.domSnapshot.stepValues.precheck}`
    );
    assertOk(
      result.domSnapshot.stepValues.unzip.includes("4 个条目"),
      `unzip 条目计数异常: ${result.domSnapshot.stepValues.unzip}`
    );
    assertOk(
      result.domSnapshot.stepValues.install.includes("4 个文件"),
      `install 文件计数异常: ${result.domSnapshot.stepValues.install}`
    );
    assertOk(
      result.domSnapshot.stepValues.relaunch.includes("正在重启"),
      `relaunch 状态异常: ${result.domSnapshot.stepValues.relaunch}`
    );

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 1 - 完整更新成功流 (5阶段进度条 + 解压条目数 4/4 + 安装文件数 4/4 + 文件落盘校验)`
    );
  }

  // 场景 2：安装子进程在写入第 x/N 个文件时遇到只读权限错误 (chmod 0o444)
  {
    const start = Date.now();
    const { result } = await runElectronScenario("mid-install-perm-error", {
      lockTargetFile: true,
    });

    assertOk(result.capturedOnError, "onError 回调应捕获到错误");
    assertEqual(result.capturedOnError.code, "PERMISSION_DENIED");
    assertEqual(result.capturedOnError.phase, "install");
    assertEqual(result.capturedOnError.stage, "更新本地文件");
    assertOk(
      result.capturedOnError.filePath.endsWith("locked-module.js"),
      `错误文件路径应指向 locked-module.js，实际为: ${result.capturedOnError.filePath}`
    );
    assertOk(
      result.capturedOnError.progress.includes("/ 4 个文件"),
      `错误应包含 x / 4 个文件进度，实际为: ${result.capturedOnError.progress}`
    );

    assertEqual(result.domSnapshot.errorDisplay, "flex");
    assertOk(result.domSnapshot.errorMessage.includes("App 管理"));
    assertOk(result.domSnapshot.errorCode.includes("PERMISSION_DENIED"));
    assertOk(result.domSnapshot.errorCode.includes("更新本地文件"));
    assertOk(
      result.domSnapshot.errorDetail.includes("错误码: PERMISSION_DENIED")
    );
    assertOk(result.domSnapshot.errorDetail.includes("子步骤: 更新本地文件"));
    assertOk(result.domSnapshot.errorDetail.includes("locked-module.js"));
    assertOk(
      result.domSnapshot.errorDetail.includes("_evdInstallerTmp.js"),
      `错误详情堆栈应保留子进程 _evdInstallerTmp.js 原始堆栈，实际为:\n${result.domSnapshot.errorDetail}`
    );

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 2 - 安装中途单文件无权限 (0o444) 精准报错定位到具体文件、x/4 进度与子进程原始堆栈并渲染错误 UI`
    );
  }

  // 场景 3：应用目录本身只读 (chmod 0o555)，模拟未授权目录或只读挂载下预检拦截
  {
    const start = Date.now();
    const { result } = await runElectronScenario("precheck-readonly-dir", {
      makeAppDirReadonly: true,
    });

    assertOk(result.capturedOnError, "onError 回调应捕获到预检权限错误");
    assertEqual(result.capturedOnError.code, "PERMISSION_DENIED");
    assertEqual(result.capturedOnError.phase, "install");
    assertEqual(result.capturedOnError.stage, "环境与权限检查");

    assertEqual(
      result.domSnapshot.errorDisplay,
      "flex",
      "即使 appPath 只读，弹窗模板也应回退到系统 temp 目录加载并正常显示错误页"
    );
    assertOk(result.domSnapshot.errorCode.includes("环境与权限检查"));
    assertOk(
      result.domSnapshot.errorDetail.includes("AppTranslocation=false")
    );

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 3 - 应用目录只读 (0o555) 时弹窗回退 temp 加载并在「环境与权限检查」阶段秒级拦截提示`
    );
  }

  {
    const start = Date.now();
    const { result: forceRes } = await runElectronScenario("force-ui-copy", {
      localVersion: "1.0.0",
      remotePkgOverrides: { minSupportedVersion: "1.5.0" },
      lockTargetFile: true,
    });
    assertEqual(forceRes.domSnapshot.windowTitle, "版本过低，必须安装新版本");
    assertEqual(forceRes.domSnapshot.documentTitle, "版本过低，必须安装新版本");
    assertEqual(forceRes.domSnapshot.headerText, "版本过低，必须安装新版本");
    assertEqual(forceRes.domSnapshot.skipBtnText, "退出软件");
    assertEqual(forceRes.domSnapshot.closeBtnText, "退出软件");
    assertEqual(forceRes.domSnapshot.retryBtnText, "重试");
    assertEqual(forceRes.domSnapshot.copyErrorBtnText, "复制错误信息");

    for (const optionalCase of [
      { label: "missing", overrides: {} },
      { label: "invalid-format", overrides: { minSupportedVersion: "v1.5.0" } },
      { label: "equal-version", overrides: { minSupportedVersion: "1.0.0" } },
    ]) {
      const { result: optRes } = await runElectronScenario(
        `optional-ui-${optionalCase.label}`,
        {
          localVersion: "1.0.0",
          remotePkgOverrides: optionalCase.overrides,
          inspectInitialOnly: true,
        }
      );
      assertEqual(optRes.domSnapshot.windowTitle, "有可用的更新");
      assertEqual(optRes.domSnapshot.documentTitle, "有可用的更新");
      assertEqual(optRes.domSnapshot.headerText, "有可用的新版本：");
      assertEqual(optRes.domSnapshot.skipBtnText, "稍后再提醒我");
      assertEqual(optRes.domSnapshot.closeBtnText, "关闭");
    }

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 4 - 强制更新与普通更新模式判定、窗口标题与按钮文案校验`
    );
  }

  {
    const start = Date.now();
    const distTemplateHtml = readFileSync(
      join(REPO_ROOT, "dist", "templates", "newVersionDialog.html"),
      "utf-8"
    );

    const legacyTemplateWithoutVersion = distTemplateHtml
      .replace(/<meta[^>]*name=["']evd-template-version["'][^>]*>/i, "")
      .replace("<body", '<body data-local-template="legacy-no-meta"');

    const { result: missingMetaRes } = await runElectronScenario(
      "template-missing-meta",
      {
        localVersion: "1.0.0",
        remotePkgOverrides: { minSupportedVersion: "1.5.0" },
        nodeModulesTemplateHtml: legacyTemplateWithoutVersion,
        inspectInitialOnly: true,
      }
    );
    assertOk(
      missingMetaRes.domSnapshot.loadedUrl.includes("_evdDialogTemplate.html"),
      `缺失版本标记时应回退内嵌模板，实际 URL: ${missingMetaRes.domSnapshot.loadedUrl}`
    );
    assertEqual(missingMetaRes.domSnapshot.bodyLocalMarker, null);
    assertOk(Boolean(missingMetaRes.domSnapshot.templateVersionMeta));
    assertEqual(missingMetaRes.domSnapshot.skipBtnText, "退出软件");

    const mismatchedTemplate =
      legacyTemplateWithoutVersion.replace(
        "<head>",
        '<head><meta name="evd-template-version" content="999" />'
      );
    const { result: mismatchMetaRes } = await runElectronScenario(
      "template-mismatch-meta",
      {
        localVersion: "1.0.0",
        remotePkgOverrides: { minSupportedVersion: "1.5.0" },
        nodeModulesTemplateHtml: mismatchedTemplate,
        inspectInitialOnly: true,
      }
    );
    assertOk(
      mismatchMetaRes.domSnapshot.loadedUrl.includes("_evdDialogTemplate.html"),
      `版本标记不匹配时应回退内嵌模板，实际 URL: ${mismatchMetaRes.domSnapshot.loadedUrl}`
    );
    assertEqual(mismatchMetaRes.domSnapshot.bodyLocalMarker, null);

    const matchedTemplate = distTemplateHtml.replace(
      "<body",
      '<body data-local-template="matched-local"'
    );
    const { result: matchedMetaRes } = await runElectronScenario(
      "template-matched-meta",
      {
        localVersion: "1.0.0",
        remotePkgOverrides: { minSupportedVersion: "1.5.0" },
        nodeModulesTemplateHtml: matchedTemplate,
        inspectInitialOnly: true,
      }
    );
    assertOk(
      matchedMetaRes.domSnapshot.loadedUrl.includes(
        "node_modules/electron-version-deployer-cli/dist/templates/newVersionDialog.html"
      ),
      `版本标记匹配时应沿用本地模板，实际 URL: ${matchedMetaRes.domSnapshot.loadedUrl}`
    );
    assertEqual(
      matchedMetaRes.domSnapshot.bodyLocalMarker,
      "matched-local"
    );
    assertEqual(matchedMetaRes.domSnapshot.skipBtnText, "退出软件");

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 5 - 模板协议版本校验：缺失或不匹配回退内嵌模板，匹配沿用本地模板`
    );
  }

  {
    const start = Date.now();

    const { result: optSkipRes } = await runElectronScenario(
      "optional-skip-no-exit",
      {
        localVersion: "1.0.0",
        stubWinClose: false,
        customActionScript: `
          await dialogWin.webContents.executeJavaScript("document.querySelector('#skipBtn').click()");
          await new Promise((r) => setTimeout(r, 80));
          writeFileSync(
            RESULT_PATH,
            JSON.stringify({
              exitCalls,
              dialogDestroyed: dialogWin.isDestroyed(),
            }, null, 2),
            "utf-8"
          );
          setTimeout(() => origExit(0), 30);
          return;
        `,
      }
    );
    assertEqual(optSkipRes.exitCalls.length, 0, "普通更新点击跳过不应调用 app.exit");
    assertEqual(optSkipRes.dialogDestroyed, true, "普通更新点击跳过应销毁弹窗");

    const { result: forceExitStagesRes } = await runElectronScenario(
      "force-exit-stages",
      {
        localVersion: "1.0.0",
        remotePkgOverrides: { minSupportedVersion: "1.5.0" },
        lockTargetFile: true,
        downloadDelayMs: 250,
        stubWinClose: false,
        customActionScript: `
          const stageExitRecords = {};

          const beforeInitialSkip = exitCalls.length;
          await dialogWin.webContents.executeJavaScript("document.querySelector('#skipBtn').click()");
          await new Promise((r) => setTimeout(r, 60));
          stageExitRecords.initialSkipBtn = exitCalls.slice(beforeInitialSkip);

          const beforeInitialClose = exitCalls.length;
          dialogWin.close();
          stageExitRecords.initialWinClose = exitCalls.slice(beforeInitialClose);

          onBeforeInstallHook = (next) => {
            const beforePrecheckClose = exitCalls.length;
            dialogWin.close();
            stageExitRecords.precheckClose = exitCalls.slice(beforePrecheckClose);
            next();
          };

          let downloadClosed = false;
          let unzipClosed = false;
          const pollStages = setInterval(async () => {
            if (dialogWin.isDestroyed()) return;
            try {
              const lastStage = await dialogWin.webContents.executeJavaScript(
                "window.__testProgressEvents?.length ? window.__testProgressEvents[window.__testProgressEvents.length - 1].stage : null"
              );
              if (lastStage === "download" && !downloadClosed) {
                downloadClosed = true;
                const beforeDownloadClose = exitCalls.length;
                dialogWin.close();
                stageExitRecords.downloadClose = exitCalls.slice(beforeDownloadClose);
              }
              if (lastStage === "unzip" && !unzipClosed) {
                unzipClosed = true;
                const beforeUnzipClose = exitCalls.length;
                dialogWin.close();
                stageExitRecords.unzipClose = exitCalls.slice(beforeUnzipClose);
              }
            } catch (_) {}
          }, 25);

          await dialogWin.webContents.executeJavaScript(\`
            (() => {
              window.__testProgressEvents = [];
              window.__testErrorEvents = [];
              const ipc = require("electron").ipcRenderer;
              ipc.on("evd-update-progress", (_, payload) => {
                window.__testProgressEvents.push(payload);
              });
              ipc.on("evd-update-error", (_, payload) => {
                window.__testErrorEvents.push(payload);
              });
              document.querySelector("#updateBtn").click();
            })();
          \`);

          await new Promise((res, rej) => {
            const deadline = Date.now() + 15000;
            const checkErr = async () => {
              if (Date.now() > deadline) return rej(new Error("Timed out waiting for error panel"));
              try {
                const errVisible = await dialogWin.webContents.executeJavaScript(
                  "document.querySelector('.error-box').style.display === 'flex'"
                );
                if (errVisible) return res();
              } catch (_) {}
              setTimeout(checkErr, 50);
            };
            checkErr();
          });
          clearInterval(pollStages);

          const beforeErrorBtn = exitCalls.length;
          await dialogWin.webContents.executeJavaScript("document.querySelector('#closeBtn').click()");
          await new Promise((r) => setTimeout(r, 60));
          stageExitRecords.errorCloseBtn = exitCalls.slice(beforeErrorBtn);

          const beforeErrorWinClose = exitCalls.length;
          dialogWin.close();
          stageExitRecords.errorWinClose = exitCalls.slice(beforeErrorWinClose);

          writeFileSync(
            RESULT_PATH,
            JSON.stringify({
              exitCalls,
              stageExitRecords,
            }, null, 2),
            "utf-8"
          );
          setTimeout(() => origExit(0), 30);
          return;
        `,
      }
    );

    for (const [key, calls] of Object.entries(
      forceExitStagesRes.stageExitRecords
    )) {
      assertOk(
        Array.isArray(calls) && calls.length >= 1 && calls[0] === 0,
        `强制模式阶段 ${key} 应调用 app.exit(0)，实际为: ${JSON.stringify(calls)}`
      );
    }

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 6 - 强制更新初始界面、precheck、下载、解压与错误面板关闭均触发 app.exit(0)，普通更新关闭不退出`
    );
  }

  {
    const start = Date.now();
    const { result: installAndRelaunchRes, updatedPkgAfter } =
      await runElectronScenario("force-install-block-and-relaunch", {
        localVersion: "1.0.0",
        remotePkgOverrides: { minSupportedVersion: "1.5.0" },
        stubWinClose: false,
        customActionScript: `
          const origSend = dialogWin.webContents.send.bind(dialogWin.webContents);
          let installStageCloseTested = false;
          let installCloseExitCalls = null;
          let installCloseDestroyed = null;

          dialogWin.webContents.send = function (channel, payload, ...rest) {
            if (
              channel === "evd-update-progress" &&
              payload &&
              payload.stage === "install" &&
              !installStageCloseTested
            ) {
              installStageCloseTested = true;
              const before = exitCalls.length;
              dialogWin.close();
              installCloseExitCalls = exitCalls.slice(before);
              installCloseDestroyed = dialogWin.isDestroyed();
            }
            return origSend(channel, payload, ...rest);
          };

          await dialogWin.webContents.executeJavaScript(
            "document.querySelector('#updateBtn').click()"
          );

          await new Promise((res, rej) => {
            const deadline = Date.now() + 15000;
            const waitRelaunch = () => {
              if (Date.now() > deadline) {
                return rej(new Error("Timed out waiting for relaunch in force mode"));
              }
              if (relaunchCalled && exitCalls.length > 0) {
                return res();
              }
              setTimeout(waitRelaunch, 40);
            };
            waitRelaunch();
          });

          writeFileSync(
            RESULT_PATH,
            JSON.stringify({
              installStageCloseTested,
              installCloseExitCalls,
              installCloseDestroyed,
              relaunchCalled,
              lifecycleOrder,
              dialogDestroyedAfterRelaunch: dialogWin.isDestroyed(),
            }, null, 2),
            "utf-8"
          );
          setTimeout(() => origExit(0), 30);
          return;
        `,
      });

    assertEqual(
      installAndRelaunchRes.installStageCloseTested,
      true,
      "应在 install 阶段触发关闭测试"
    );
    assertEqual(
      installAndRelaunchRes.installCloseExitCalls.length,
      0,
      "install 阶段关闭弹窗应被拦截，不得调用 app.exit"
    );
    assertEqual(
      installAndRelaunchRes.installCloseDestroyed,
      false,
      "install 阶段关闭弹窗应被拦截，窗口不得被销毁"
    );
    assertEqual(installAndRelaunchRes.relaunchCalled, true);
    assertEqual(
      installAndRelaunchRes.dialogDestroyedAfterRelaunch,
      true,
      "更新成功后进入重启流程应放行关闭弹窗"
    );
    assertEqual(
      installAndRelaunchRes.lifecycleOrder[0],
      "relaunch",
      `更新成功后应先调用 app.relaunch() 再调用 app.exit()，实际顺序: ${JSON.stringify(
        installAndRelaunchRes.lifecycleOrder
      )}`
    );
    assertEqual(updatedPkgAfter.version, "2.0.0");

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 7 - 强制更新 install 阶段拦截关闭，更新完成后放行关闭并正常执行 app.relaunch()`
    );
  }

  {
    const start = Date.now();
    const { result: hostClosedRes } = await runElectronScenario(
      "force-host-windows-closed",
      {
        localVersion: "1.0.0",
        remotePkgOverrides: { minSupportedVersion: "1.5.0" },
        stubWinClose: false,
        customActionScript: `
          const hostWin = new BrowserWindow({ show: false });
          await new Promise((r) => setTimeout(r, 1150));
          const beforeCloseExitCount = exitCalls.length;
          hostWin.close();
          await new Promise((r) => setTimeout(r, 60));

          writeFileSync(
            RESULT_PATH,
            JSON.stringify({
              exitCallsAfterHostClosed: exitCalls.slice(beforeCloseExitCount),
              dialogDestroyed: dialogWin.isDestroyed(),
            }, null, 2),
            "utf-8"
          );
          setTimeout(() => origExit(0), 30);
          return;
        `,
      }
    );

    assertOk(
      Array.isArray(hostClosedRes.exitCallsAfterHostClosed) &&
        hostClosedRes.exitCallsAfterHostClosed.length >= 1 &&
        hostClosedRes.exitCallsAfterHostClosed[0] === 0,
      `宿主其它窗口全部关闭只剩弹窗时应调用 app.exit(0)，实际为: ${JSON.stringify(
        hostClosedRes.exitCallsAfterHostClosed
      )}`
    );
    assertEqual(
      hostClosedRes.dialogDestroyed,
      false,
      "强制模式下只剩弹窗时不应调用 cleanup 销毁弹窗"
    );

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 8 - 强制更新下宿主其它窗口全部关闭只剩弹窗时调用 app.exit(0) 且不销毁弹窗`
    );
  }

  {
    const start = Date.now();
    const { result: darwinBlockRes } = await runElectronScenario(
      "force-initial-block-darwin",
      {
        localVersion: "1.0.0",
        remotePkgOverrides: { minSupportedVersion: "1.5.0" },
        beforeInitialCheckScript: `
          Object.defineProperty(process, "platform", {
            value: "darwin",
            configurable: true,
          });
          const hostWin1 = new BrowserWindow({ show: false });
          hostWin1.__isTestHostWin = true;
          hostWin1.show();
          const hostWin2 = new BrowserWindow({ show: false });
          hostWin2.__isTestHostWin = true;
          hostWin2.show();
        `,
        customActionScript: `
          writeFileSync(
            RESULT_PATH,
            JSON.stringify({
              dialogSkipTaskbar: dialogWin.__testSkipTaskbar,
              dialogSkipTaskbarCalls: dialogWin.__testSkipTaskbarCalls || [],
              hostWin1Visible: hostWin1.isVisible(),
              hostWin2Visible: hostWin2.isVisible(),
              hostWin1HideCalls: hostWin1.__testHideCalls || 0,
              hostWin2HideCalls: hostWin2.__testHideCalls || 0,
              hostWin1SetEnabledCalls: hostWin1.__testSetEnabledCalls || [],
              hostWin2SetEnabledCalls: hostWin2.__testSetEnabledCalls || [],
            }, null, 2),
            "utf-8"
          );
          setTimeout(() => origExit(0), 30);
          return;
        `,
      }
    );

    assertEqual(
      darwinBlockRes.dialogSkipTaskbar,
      false,
      "强制模式下弹窗 skipTaskbar 应设为 false"
    );
    assertOk(
      darwinBlockRes.dialogSkipTaskbarCalls.includes(false),
      "强制模式下应调用 setSkipTaskbar(false)"
    );
    assertEqual(
      darwinBlockRes.hostWin1Visible,
      false,
      "进入强制模式时应隐藏现有主窗口 1"
    );
    assertEqual(
      darwinBlockRes.hostWin2Visible,
      false,
      "进入强制模式时应隐藏现有主窗口 2"
    );
    assertOk(darwinBlockRes.hostWin1HideCalls >= 1);
    assertOk(darwinBlockRes.hostWin2HideCalls >= 1);
    assertEqual(
      darwinBlockRes.hostWin1SetEnabledCalls.length,
      0,
      "macOS 平台不应调用 setEnabled(false)"
    );
    assertEqual(
      darwinBlockRes.hostWin2SetEnabledCalls.length,
      0,
      "macOS 平台不应调用 setEnabled(false)"
    );

    const { result: nonDarwinBlockRes } = await runElectronScenario(
      "force-initial-block-non-darwin",
      {
        localVersion: "1.0.0",
        remotePkgOverrides: { minSupportedVersion: "1.5.0" },
        beforeInitialCheckScript: `
          Object.defineProperty(process, "platform", {
            value: "win32",
            configurable: true,
          });
          const hostWin1 = new BrowserWindow({ show: false });
          hostWin1.__isTestHostWin = true;
          hostWin1.show();
          const hostWin2 = new BrowserWindow({ show: false });
          hostWin2.__isTestHostWin = true;
          hostWin2.show();
        `,
        customActionScript: `
          writeFileSync(
            RESULT_PATH,
            JSON.stringify({
              dialogSkipTaskbar: dialogWin.__testSkipTaskbar,
              hostWin1Visible: hostWin1.isVisible(),
              hostWin2Visible: hostWin2.isVisible(),
              hostWin1Enabled: hostWin1.isEnabled(),
              hostWin2Enabled: hostWin2.isEnabled(),
              hostWin1SetEnabledCalls: hostWin1.__testSetEnabledCalls || [],
              hostWin2SetEnabledCalls: hostWin2.__testSetEnabledCalls || [],
            }, null, 2),
            "utf-8"
          );
          setTimeout(() => origExit(0), 30);
          return;
        `,
      }
    );

    assertEqual(nonDarwinBlockRes.dialogSkipTaskbar, false);
    assertEqual(nonDarwinBlockRes.hostWin1Visible, false);
    assertEqual(nonDarwinBlockRes.hostWin2Visible, false);
    assertEqual(
      nonDarwinBlockRes.hostWin1Enabled,
      false,
      "非 macOS 平台应同步对现有窗口调用 setEnabled(false)"
    );
    assertEqual(
      nonDarwinBlockRes.hostWin2Enabled,
      false,
      "非 macOS 平台应同步对现有窗口调用 setEnabled(false)"
    );
    assertOk(nonDarwinBlockRes.hostWin1SetEnabledCalls.includes(false));
    assertOk(nonDarwinBlockRes.hostWin2SetEnabledCalls.includes(false));

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 9 - 强制模式设置 skipTaskbar(false) 并隐藏全部现有非弹窗窗口（非 macOS 补充 setEnabled(false)）`
    );
  }

  {
    const start = Date.now();
    const { result: interceptRes } = await runElectronScenario(
      "force-anti-wakeup-interception",
      {
        localVersion: "1.0.0",
        remotePkgOverrides: { minSupportedVersion: "1.5.0" },
        beforeInitialCheckScript: `
          const hostWin = new BrowserWindow({ show: false });
          hostWin.__isTestHostWin = true;
          hostWin.show();
        `,
        customActionScript: `
          const records = {};

          const snap = (targetWin, prevHideCalls, prevDialogFocusCalls) => ({
            visible: targetWin.isVisible(),
            hideDelta: (targetWin.__testHideCalls || 0) - prevHideCalls,
            dialogFocusDelta: (dialogWin.__testFocusCalls || 0) - prevDialogFocusCalls,
            lastFocusedIsDialog: lastFocusedWindow === dialogWin,
          });

          let hHide = hostWin.__testHideCalls || 0;
          let dFocus = dialogWin.__testFocusCalls || 0;
          lastFocusedWindow = hostWin;
          hostWin.show();
          records.existingShow = snap(hostWin, hHide, dFocus);

          hHide = hostWin.__testHideCalls || 0;
          dFocus = dialogWin.__testFocusCalls || 0;
          lastFocusedWindow = hostWin;
          hostWin.showInactive();
          records.existingShowInactive = snap(hostWin, hHide, dFocus);

          hHide = hostWin.__testHideCalls || 0;
          dFocus = dialogWin.__testFocusCalls || 0;
          lastFocusedWindow = hostWin;
          app.emit("browser-window-focus", {}, hostWin);
          records.existingFocusFallback = snap(hostWin, hHide, dFocus);

          dFocus = dialogWin.__testFocusCalls || 0;
          lastFocusedWindow = hostWin;
          const lateWin = new BrowserWindow({ show: false });
          lateWin.__isTestHostWin = true;
          records.newWinCreated = snap(lateWin, 0, dFocus);

          hHide = lateWin.__testHideCalls || 0;
          dFocus = dialogWin.__testFocusCalls || 0;
          lastFocusedWindow = lateWin;
          lateWin.show();
          records.newWinShow = snap(lateWin, hHide, dFocus);

          hHide = lateWin.__testHideCalls || 0;
          dFocus = dialogWin.__testFocusCalls || 0;
          lastFocusedWindow = lateWin;
          lateWin.showInactive();
          records.newWinShowInactive = snap(lateWin, hHide, dFocus);

          writeFileSync(
            RESULT_PATH,
            JSON.stringify({ records }, null, 2),
            "utf-8"
          );
          setTimeout(() => origExit(0), 30);
          return;
        `,
      }
    );

    for (const [caseName, rec] of Object.entries(interceptRes.records)) {
      assertEqual(
        rec.visible,
        false,
        `强制模式拦截路径 [${caseName}] 应将非弹窗窗口隐藏`
      );
      assertOk(
        rec.hideDelta >= 1,
        `强制模式拦截路径 [${caseName}] 应调用目标窗口 hide()，实际 hideDelta=${rec.hideDelta}`
      );
      assertOk(
        rec.dialogFocusDelta >= 1,
        `强制模式拦截路径 [${caseName}] 应调用弹窗 focus()，实际 dialogFocusDelta=${rec.dialogFocusDelta}`
      );
      assertEqual(
        rec.lastFocusedIsDialog,
        true,
        `强制模式拦截路径 [${caseName}] 最终焦点应回到更新弹窗`
      );
    }

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 10 - 强制模式期间现有窗口 show/showInactive/聚焦 与新建窗口（含 show:false 后再显示）均自动隐藏并聚焦回弹窗`
    );
  }

  {
    const start = Date.now();
    const { result: upgradeRes } = await runElectronScenario(
      "live-upgrade-optional-to-force-and-no-downgrade",
      {
        localVersion: "1.0.0",
        remotePkgOverrides: {},
        lockTargetFile: true,
        stubWinClose: false,
        beforeInitialCheckScript: `
          const hostWin = new BrowserWindow({ show: false });
          hostWin.__isTestHostWin = true;
          hostWin.show();
        `,
        customActionScript: `
          const readDialogUI = async () => {
            const dom = await dialogWin.webContents.executeJavaScript(\`({
              documentTitle: document.title,
              headerText: document.querySelector(".title-bar span")?.textContent || "",
              skipBtnText: document.querySelector("#skipBtn")?.textContent || "",
              closeBtnText: document.querySelector("#closeBtn")?.textContent || "",
              errorVisible: document.querySelector(".error-box")?.style.display === "flex",
            })\`);
            dom.windowTitle = dialogWin.getTitle();
            dom.skipTaskbar = dialogWin.__testSkipTaskbar;
            dom.hostWinVisible = hostWin.isVisible();
            return dom;
          };

          const beforeUpgrade = await readDialogUI();

          await dialogWin.webContents.executeJavaScript("document.querySelector('#updateBtn').click()");
          await new Promise((res, rej) => {
            const deadline = Date.now() + 15000;
            const waitErr = async () => {
              if (Date.now() > deadline) return rej(new Error("Timed out waiting for error panel before live upgrade"));
              try {
                const visible = await dialogWin.webContents.executeJavaScript(
                  "document.querySelector('.error-box').style.display === 'flex'"
                );
                if (visible) return res();
              } catch (_) {}
              setTimeout(waitErr, 50);
            };
            waitErr();
          });

          const onErrorPanelBeforeUpgrade = await readDialogUI();

          setRemotePkg({ minSupportedVersion: "1.5.0" });
          await EVDCheckUpdate();
          await new Promise((r) => setTimeout(r, 80));

          const afterUpgrade = await readDialogUI();

          const prevHide = hostWin.__testHideCalls || 0;
          const prevFocus = dialogWin.__testFocusCalls || 0;
          hostWin.show();
          const wakeAfterUpgrade = {
            hostVisible: hostWin.isVisible(),
            hideDelta: (hostWin.__testHideCalls || 0) - prevHide,
            focusDelta: (dialogWin.__testFocusCalls || 0) - prevFocus,
          };

          const exitCountBeforeCloseBtn = exitCalls.length;
          await dialogWin.webContents.executeJavaScript("document.querySelector('#closeBtn').click()");
          await new Promise((r) => setTimeout(r, 60));
          const exitCallsOnErrorCloseBtn = exitCalls.slice(exitCountBeforeCloseBtn);

          setRemotePkg({});
          await EVDCheckUpdate();
          await new Promise((r) => setTimeout(r, 80));

          const afterRemoteRevert = await readDialogUI();

          const prevHideRevert = hostWin.__testHideCalls || 0;
          hostWin.showInactive();
          const wakeAfterRevert = {
            hostVisible: hostWin.isVisible(),
            hideDelta: (hostWin.__testHideCalls || 0) - prevHideRevert,
          };

          const exitCountBeforeWinClose = exitCalls.length;
          dialogWin.close();
          const exitCallsAfterRevertWinClose = exitCalls.slice(exitCountBeforeWinClose);

          writeFileSync(
            RESULT_PATH,
            JSON.stringify({
              beforeUpgrade,
              onErrorPanelBeforeUpgrade,
              afterUpgrade,
              wakeAfterUpgrade,
              exitCallsOnErrorCloseBtn,
              afterRemoteRevert,
              wakeAfterRevert,
              exitCallsAfterRevertWinClose,
              dialogDestroyed: dialogWin.isDestroyed(),
            }, null, 2),
            "utf-8"
          );
          setTimeout(() => origExit(0), 30);
          return;
        `,
      }
    );

    assertEqual(upgradeRes.beforeUpgrade.windowTitle, "有可用的更新");
    assertEqual(upgradeRes.beforeUpgrade.skipBtnText, "稍后再提醒我");
    assertEqual(upgradeRes.beforeUpgrade.closeBtnText, "关闭");
    assertEqual(
      upgradeRes.beforeUpgrade.hostWinVisible,
      true,
      "普通更新模式下主窗口应保持可见"
    );
    assertEqual(upgradeRes.onErrorPanelBeforeUpgrade.errorVisible, true);
    assertEqual(upgradeRes.onErrorPanelBeforeUpgrade.closeBtnText, "关闭");

    assertEqual(
      upgradeRes.afterUpgrade.windowTitle,
      "版本过低，必须安装新版本",
      "原位升级后窗口标题应更新"
    );
    assertEqual(
      upgradeRes.afterUpgrade.documentTitle,
      "版本过低，必须安装新版本",
      "原位升级后 document.title 应更新"
    );
    assertEqual(
      upgradeRes.afterUpgrade.headerText,
      "版本过低，必须安装新版本",
      "原位升级后顶部提示应更新"
    );
    assertEqual(
      upgradeRes.afterUpgrade.skipBtnText,
      "退出软件",
      "原位升级后 #skipBtn 文案应变为退出软件"
    );
    assertEqual(
      upgradeRes.afterUpgrade.closeBtnText,
      "退出软件",
      "原位升级后错误面板 #closeBtn 文案应同步变为退出软件"
    );
    assertEqual(
      upgradeRes.afterUpgrade.skipTaskbar,
      false,
      "原位升级后应调用 setSkipTaskbar(false)"
    );
    assertEqual(
      upgradeRes.afterUpgrade.hostWinVisible,
      false,
      "原位升级后应立即隐藏宿主其它窗口"
    );
    assertEqual(upgradeRes.wakeAfterUpgrade.hostVisible, false);
    assertOk(upgradeRes.wakeAfterUpgrade.hideDelta >= 1);
    assertOk(upgradeRes.wakeAfterUpgrade.focusDelta >= 1);
    assertOk(
      upgradeRes.exitCallsOnErrorCloseBtn.length >= 1 &&
        upgradeRes.exitCallsOnErrorCloseBtn[0] === 0,
      "原位升级后错误面板关闭规则应立即生效并调用 app.exit(0)"
    );

    assertEqual(
      upgradeRes.afterRemoteRevert.windowTitle,
      "版本过低，必须安装新版本",
      "远程改回普通更新后应保持强制更新标题不回退"
    );
    assertEqual(
      upgradeRes.afterRemoteRevert.documentTitle,
      "版本过低，必须安装新版本"
    );
    assertEqual(upgradeRes.afterRemoteRevert.skipBtnText, "退出软件");
    assertEqual(upgradeRes.afterRemoteRevert.closeBtnText, "退出软件");
    assertEqual(upgradeRes.afterRemoteRevert.skipTaskbar, false);
    assertEqual(upgradeRes.wakeAfterRevert.hostVisible, false);
    assertOk(upgradeRes.wakeAfterRevert.hideDelta >= 1);
    assertOk(
      upgradeRes.exitCallsAfterRevertWinClose.length >= 1 &&
        upgradeRes.exitCallsAfterRevertWinClose[0] === 0,
      "远程改回普通更新后关闭弹窗仍应调用 app.exit(0)"
    );
    assertEqual(upgradeRes.dialogDestroyed, false);

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 11 - 普通更新弹窗原位升级为强制模式（含错误面板同步更新与窗口阻断）且远程改回普通更新时不回退`
    );
  }

  {
    const start = Date.now();
    const { result, updatedPkgAfter, appFilesAfter } =
      await runElectronScenario("extra-folders-hot-update", {
        initialAppFiles: {
          "resources/config.json": '{"theme":"light"}',
          "resources/legacy.txt": "keep-legacy-file",
        },
        extraZipEntries: {
          "resources/config.json": '{"theme":"dark"}',
          "resources/nested/new-icon.svg": '<svg id="new"/>',
        },
        readAppFiles: [
          "resources/config.json",
          "resources/nested/new-icon.svg",
          "resources/legacy.txt",
        ],
      });

    assertEqual(result.hasUpdate, true);
    assertEqual(result.capturedOnError, null);
    assertEqual(updatedPkgAfter.version, "2.0.0");
    assertEqual(
      appFilesAfter["resources/config.json"],
      '{"theme":"dark"}',
      "extraFolders 原有同名文件应被覆盖更新"
    );
    assertEqual(
      appFilesAfter["resources/nested/new-icon.svg"],
      '<svg id="new"/>',
      "extraFolders 新增嵌套子目录与文件应成功写入"
    );
    assertEqual(
      appFilesAfter["resources/legacy.txt"],
      "keep-legacy-file",
      "extraFolders 本地原有的其它历史文件应保留不删"
    );

    console.log(
      `✅ PASS (${Date.now() - start}ms): E2E 场景 12 - extraFolders 客户端热更新落盘（同名文件覆盖、新增嵌套文件写入、历史文件保留）`
    );
  }
}

main().catch((err) => {
  console.error("❌ E2E 测试失败:", err);
  process.exit(1);
});

