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
const { join, resolve } = require("node:path");
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
function startMockUpdateServer(zipPath, remotePkg) {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || "").split("?")[0];
      if (urlPath === "/package.json") {
        const body = JSON.stringify(remotePkg);
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
            version: remotePkg.version,
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
        const buf = readFileSync(zipPath);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": buf.length,
        });
        res.end(buf);
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
    };

    await createUpdateZip(zipPath, {
      "package.json": JSON.stringify(remotePkg, null, 2),
      "src/featureA.js": "module.exports = 'featureA v2.0.0';\n",
      "src/featureB.js": "module.exports = 'featureB v2.0.0';\n",
      "locked-module.js": "module.exports = 'updated locked module v2.0.0';\n",
    });

    const { server, url: remoteUrl } = await startMockUpdateServer(
      zipPath,
      remotePkg
    );

    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify(
        {
          name: "mock-evd-app",
          version: "1.0.0",
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

    if (setupOptions.lockTargetFile) {
      chmodSync(join(appDir, "locked-module.js"), 0o444);
    }

    const resultJsonPath = join(tempBase, "result.json");

    // 构造 Electron 主进程入口脚本
    const mainScript = `
const { app, BrowserWindow } = require("electron");
const { writeFileSync, chmodSync } = require("node:fs");
const { EVDInit, EVDCheckUpdate } = require(${JSON.stringify(DIST_MAIN)});

const RESULT_PATH = ${JSON.stringify(resultJsonPath)};
const REMOTE_URL = ${JSON.stringify(remoteUrl)};
const MAKE_APP_DIR_READONLY = ${JSON.stringify(
      !!setupOptions.makeAppDirReadonly
    )};
const APP_DIR = ${JSON.stringify(appDir)};

let capturedOnError = null;
let relaunchCalled = false;
let exitIntercepted = false;

const origExit = app.exit.bind(app);
app.relaunch = () => {
  relaunchCalled = true;
};
app.exit = () => {
  exitIntercepted = true;
};
// 静默窗口展示，避免自动化测试期间弹窗闪烁
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};

app.whenReady().then(async () => {
  try {
    EVDInit({
      remoteUrl: REMOTE_URL,
      detectAtStart: false,
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
          if (wins.length > 0) {
            const win = wins[0];
            // 阻止成功更新后 1ms 自动关闭销毁窗口，以便读取最终 DOM 状态
            win.close = () => {};
            try {
              const ready = await win.webContents.executeJavaScript(
                "Boolean(document.querySelector('#updateBtn') && document.querySelector('#stagePercent'))"
              );
              if (ready) {
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
        resolveScenario({ result, updatedPkgAfter, featureAAfter, appDir });
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
}

main().catch((err) => {
  console.error("❌ E2E 测试失败:", err);
  process.exit(1);
});
