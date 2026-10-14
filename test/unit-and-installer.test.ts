import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  EVDErrorCodeEnum,
  EVDErrorPhaseEnum,
  formatEVDErrorDetail,
  isEVDError,
} from "@/types/EVDErrorType";
import {
  describeRuntimeEnvironment,
  detectUpdateEnvironment,
  toEVDError,
} from "@/helpers/toEVDError";
import { compareObjectsIsEqual } from "@/utils/compareObjectsIsEqual";
import { createServer } from "node:http";
import { program } from "commander";
import extract from "extract-zip";
import {
  applyMinSupportedVersion,
  createCheckPolicy,
  extractMinVersionCLIOptions,
  resolveMinSupportedVersion,
  runDeployChecks,
} from "../cli/helpers/deployChecks";
import { getWhichProvider } from "../cli/helpers/getWhichProvider";
import { copySourceAndZipFiles } from "../cli/commands/prepare";
import { runChecks } from "../cli/commands/verify";
import "../cli/commands/preDeploy";

const assert = {
  ok(cond: unknown, msg = "Assertion failed") {
    if (!cond) throw new Error(msg);
  },
  equal<T>(actual: T, expected: T, msg?: string) {
    if (actual !== expected) {
      throw new Error(
        msg ||
          `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  },
  throws(fn: () => unknown, validate?: (err: unknown) => boolean) {
    let threw = false;
    try {
      fn();
    } catch (err) {
      threw = true;
      if (validate && !validate(err)) {
        throw new Error(`Thrown error did not pass validation: ${err}`);
      }
    }
    if (!threw) {
      throw new Error("Expected function to throw, but it did not");
    }
  },
};

const installerTemplate = readFileSync(
  resolve(__dirname, "../src/installer.js"),
  "utf-8"
);

async function runTest(name: string, fn: () => Promise<void> | void) {
  const start = Date.now();
  try {
    await fn();
    console.log(`✅ PASS (${Date.now() - start}ms): ${name}`);
  } catch (err) {
    console.error(`❌ FAIL (${Date.now() - start}ms): ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

/**
 * 在 Node 子进程中模拟 Electron utilityProcess.fork 的 process.parentPort.postMessage 行为
 */
function runInstallerInChild(
  sourceDir: string,
  targetDir: string,
  workDir: string
): Promise<{
  exitCode: number | null;
  messages: any[];
  stdout: string;
  stderr: string;
}> {
  return new Promise((resultResolve) => {
    const normalize = (p: string) => p.split("\\").join("/");
    const scriptBody = installerTemplate
      .replace("__unzipPath__", () => normalize(sourceDir))
      .replace("__appPath__", () => normalize(targetDir));

    const shim = `
process.parentPort = {
  postMessage(msg) {
    if (typeof process.send === "function") {
      process.send(msg);
    }
  }
};
`;
    const installerPath = join(workDir, "_evdInstallerTmp.cjs");
    writeFileSync(installerPath, shim + "\n" + scriptBody, "utf-8");

    const child = spawn(process.execPath, [installerPath], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const messages: any[] = [];
    let stdout = "";
    let stderr = "";

    child.on("message", (msg) => {
      messages.push(msg);
    });
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("exit", (exitCode) => {
      resultResolve({ exitCode, messages, stdout, stderr });
    });
  });
}

async function main() {
  console.log("=== 1. 环境探测与错误归一化单元测试 ===");

  if (process.platform === "darwin") {
    await runTest(
      "detectUpdateEnvironment: 识别 macOS App Translocation 只读沙盒路径",
      () => {
        const fakeTranslocatedPath =
          "/private/var/folders/xx/yy/T/AppTranslocation/1234-5678/d/MyApp.app/Contents/Resources/app";
        assert.throws(
          () => detectUpdateEnvironment(fakeTranslocatedPath),
          (err: unknown) => {
            assert.ok(isEVDError(err));
            assert.equal(err.code, EVDErrorCodeEnum.APP_TRANSLOCATION);
            assert.equal(err.phase, EVDErrorPhaseEnum.INSTALL);
            assert.equal(err.stage, "环境与权限检查");
            assert.equal(err.filePath, fakeTranslocatedPath);
            assert.ok(err.message.includes("App Translocation"));
            return true;
          }
        );
      }
    );

    await runTest(
      "detectUpdateEnvironment: 识别 macOS /Volumes/ DMG 只读挂载卷路径",
      () => {
        const fakeVolumesPath =
          "/Volumes/MyApp Installer/MyApp.app/Contents/Resources/app";
        assert.throws(
          () => detectUpdateEnvironment(fakeVolumesPath),
          (err: unknown) => {
            assert.ok(isEVDError(err));
            assert.equal(err.code, EVDErrorCodeEnum.READ_ONLY_VOLUME);
            assert.equal(err.phase, EVDErrorPhaseEnum.INSTALL);
            assert.equal(err.filePath, fakeVolumesPath);
            assert.ok(err.message.includes("DMG 安装镜像"));
            return true;
          }
        );
      }
    );
  }

  await runTest(
    "detectUpdateEnvironment: 识别真实只读目录 (chmod 0o555) -> PERMISSION_DENIED",
    () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "evd-perm-test-"));
      try {
        chmodSync(tempRoot, 0o555);
        assert.throws(
          () => detectUpdateEnvironment(tempRoot),
          (err: unknown) => {
            assert.ok(isEVDError(err));
            assert.equal(err.code, EVDErrorCodeEnum.PERMISSION_DENIED);
            assert.equal(err.filePath, tempRoot);
            return true;
          }
        );
      } finally {
        chmodSync(tempRoot, 0o755);
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  );

  await runTest(
    "detectUpdateEnvironment & describeRuntimeEnvironment: 正常可写目录通过检测",
    () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "evd-writable-test-"));
      try {
        detectUpdateEnvironment(tempRoot);
        const summary = describeRuntimeEnvironment(tempRoot);
        assert.ok(summary.includes(`appPath=${tempRoot}`));
        assert.ok(summary.includes("mode=0o7"));
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  );

  await runTest(
    "detectUpdateEnvironment: 非权限/非只读异常（如 ENOENT 目录不存在）归类为 UNKNOWN 而非误报 PERMISSION_DENIED",
    () => {
      const nonExistentPath = join(
        tmpdir(),
        `evd-missing-${Date.now()}-${Math.random()}`
      );
      assert.throws(
        () => detectUpdateEnvironment(nonExistentPath),
        (err: unknown) => {
          assert.ok(isEVDError(err));
          assert.equal(err.code, EVDErrorCodeEnum.UNKNOWN);
          assert.equal(err.filePath, nonExistentPath);
          return true;
        }
      );
    }
  );

  await runTest(
    "toEVDError & formatEVDErrorDetail: EROFS / ENOSPC / EACCES、error.path 优先于 ctx.filePath、fallbackCode 与子进程 stack 保留",
    () => {
      const erofsErr = Object.assign(
        new Error("EROFS: read-only file system, open '/foo/bar.js'"),
        {
          code: "EROFS",
          path: "/foo/bar.js",
        }
      );
      const evdErofs = toEVDError(
        erofsErr,
        {
          phase: EVDErrorPhaseEnum.INSTALL,
          stage: "解压更新包",
          progress: "3 / 10 个条目",
          filePath: "fallback-entry.js",
        },
        EVDErrorCodeEnum.UNZIP_FAILED
      );
      assert.equal(evdErofs.code, EVDErrorCodeEnum.READ_ONLY_VOLUME);
      assert.equal(
        evdErofs.filePath,
        "/foo/bar.js",
        "error.path should take precedence over ctx.filePath"
      );
      assert.equal(evdErofs.stage, "解压更新包");
      assert.equal(evdErofs.progress, "3 / 10 个条目");

      const enospcErr = Object.assign(
        new Error("ENOSPC: no space left on device, write"),
        {
          code: "ENOSPC",
          path: "/foo/large.bin",
        }
      );
      const evdEnospc = toEVDError(enospcErr, {
        phase: EVDErrorPhaseEnum.INSTALL,
        stage: "解压更新包",
      });
      assert.equal(evdEnospc.code, EVDErrorCodeEnum.DISK_FULL);
      assert.equal(evdEnospc.filePath, "/foo/large.bin");

      const corruptZipErr = new Error("invalid central directory file header");
      const evdUnzipFallback = toEVDError(
        corruptZipErr,
        {
          phase: EVDErrorPhaseEnum.INSTALL,
          stage: "解压更新包",
          filePath: "entry-a.js",
        },
        EVDErrorCodeEnum.UNZIP_FAILED
      );
      assert.equal(evdUnzipFallback.code, EVDErrorCodeEnum.UNZIP_FAILED);
      assert.equal(evdUnzipFallback.filePath, "entry-a.js");

      const childInstallErr = toEVDError(
        "EACCES: permission denied, open '/app/locked.js'",
        {
          phase: EVDErrorPhaseEnum.INSTALL,
          stage: "更新本地文件",
          progress: "1 / 4 个文件",
          filePath: "/app/locked.js",
          stack: "Error: EACCES: permission denied\n    at copySingleFileWithProgress (_evdInstallerTmp.js:140:5)",
        },
        EVDErrorCodeEnum.INSTALL_FAILED
      );
      assert.equal(childInstallErr.code, EVDErrorCodeEnum.PERMISSION_DENIED);
      const childDetailText = formatEVDErrorDetail(childInstallErr, {
        当前版本: "1.0.0",
      });
      assert.ok(childDetailText.includes("错误码: PERMISSION_DENIED"));
      assert.ok(childDetailText.includes("子步骤: 更新本地文件"));
      assert.ok(childDetailText.includes("当前进度: 1 / 4 个文件"));
      assert.ok(childDetailText.includes("卡在文件: /app/locked.js"));
      assert.ok(childDetailText.includes("当前版本: 1.0.0"));
      assert.ok(
        childDetailText.includes("copySingleFileWithProgress (_evdInstallerTmp.js:140:5)"),
        "formatEVDErrorDetail should preserve child installer stack"
      );
    }
  );

  await runTest("compareObjectsIsEqual: 空值与对象比对安全性", () => {
    assert.equal(compareObjectsIsEqual(undefined, undefined), true);
    assert.equal(compareObjectsIsEqual(null, null), true);
    assert.equal(compareObjectsIsEqual(undefined, { a: "1" }), false);
    assert.equal(
      compareObjectsIsEqual({ a: "1", b: "2" }, { b: "2", a: "1" }),
      true
    );
    assert.equal(compareObjectsIsEqual({ a: "1" }, { a: "2" }), false);
  });

  console.log("\n=== 2. Installer 子进程集成测试 ===");

  await runTest(
    "installer.js: 精确统计需复制文件数、跳过未变更依赖、自动创建缺失 node_modules 并上报完成进度",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "evd-installer-ok-"));
      const sourceDir = join(workDir, "evdUnzip");
      const targetDir = join(workDir, "app");

      try {
        mkdirSync(join(sourceDir, "dist"), { recursive: true });
        mkdirSync(join(sourceDir, "node_modules", "unchanged-pkg"), {
          recursive: true,
        });
        mkdirSync(join(sourceDir, "node_modules", "updated-pkg"), {
          recursive: true,
        });
        mkdirSync(join(sourceDir, "node_modules", "@scope", "new-pkg"), {
          recursive: true,
        });

        writeFileSync(
          join(sourceDir, "package.json"),
          JSON.stringify({ version: "2.0.0" })
        );
        writeFileSync(join(sourceDir, "dist", "main.js"), "console.log('v2');");

        writeFileSync(
          join(sourceDir, "node_modules", "unchanged-pkg", "package.json"),
          JSON.stringify({ name: "unchanged-pkg", version: "1.0.0" })
        );
        writeFileSync(
          join(sourceDir, "node_modules", "unchanged-pkg", "index.js"),
          "module.exports = 'source-should-not-overwrite';"
        );

        writeFileSync(
          join(sourceDir, "node_modules", "updated-pkg", "package.json"),
          JSON.stringify({ name: "updated-pkg", version: "2.0.0" })
        );
        writeFileSync(
          join(sourceDir, "node_modules", "updated-pkg", "index.js"),
          "module.exports = 'v2.0.0';"
        );

        writeFileSync(
          join(sourceDir, "node_modules", "@scope", "new-pkg", "package.json"),
          JSON.stringify({ name: "@scope/new-pkg", version: "1.0.0" })
        );
        writeFileSync(
          join(sourceDir, "node_modules", "@scope", "new-pkg", "index.js"),
          "module.exports = 'scoped-v1';"
        );

        mkdirSync(join(targetDir, "node_modules", "unchanged-pkg"), {
          recursive: true,
        });
        mkdirSync(join(targetDir, "node_modules", "updated-pkg"), {
          recursive: true,
        });
        writeFileSync(
          join(targetDir, "package.json"),
          JSON.stringify({ version: "1.0.0" })
        );
        writeFileSync(
          join(targetDir, "node_modules", "unchanged-pkg", "package.json"),
          JSON.stringify({ name: "unchanged-pkg", version: "1.0.0" })
        );
        writeFileSync(
          join(targetDir, "node_modules", "unchanged-pkg", "index.js"),
          "module.exports = 'keep-original';"
        );
        writeFileSync(
          join(targetDir, "node_modules", "updated-pkg", "package.json"),
          JSON.stringify({ name: "updated-pkg", version: "1.0.0" })
        );
        writeFileSync(
          join(targetDir, "node_modules", "updated-pkg", "index.js"),
          "module.exports = 'v1.0.0';"
        );

        const res = await runInstallerInChild(sourceDir, targetDir, workDir);
        assert.equal(
          res.exitCode,
          0,
          `Expected exitCode 0, got ${res.exitCode}. stderr: ${res.stderr}`
        );

        const progressMsgs = res.messages.filter(
          (m) => m && m.type === "progress"
        );
        const doneMsg = res.messages.find((m) => m && m.type === "done");
        assert.ok(
          progressMsgs.length >= 2,
          "Should emit at least initial and final progress messages"
        );
        assert.equal(
          progressMsgs[0].total,
          6,
          "Pre-counted total files should be 6 (skipping unchanged-pkg)"
        );
        assert.ok(doneMsg, "Should emit done message");
        assert.equal(doneMsg.completed, 6);
        assert.equal(doneMsg.total, 6);
        assert.ok(
          res.messages.includes("exitManually"),
          "Should emit legacy exitManually message"
        );

        assert.equal(
          readFileSync(
            join(targetDir, "node_modules", "unchanged-pkg", "index.js"),
            "utf-8"
          ),
          "module.exports = 'keep-original';"
        );
        assert.equal(
          readFileSync(
            join(targetDir, "node_modules", "updated-pkg", "index.js"),
            "utf-8"
          ),
          "module.exports = 'v2.0.0';"
        );
        assert.equal(
          readFileSync(
            join(targetDir, "node_modules", "@scope", "new-pkg", "index.js"),
            "utf-8"
          ),
          "module.exports = 'scoped-v1';"
        );
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  );

  await runTest(
    "installer.js: 当目标文件只读无权限 (0o444) 时，不再静默吞错，准确上报错误文件路径与已复制进度并以 exitCode=1 退出",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "evd-installer-err-"));
      const sourceDir = join(workDir, "evdUnzip");
      const targetDir = join(workDir, "app");

      try {
        mkdirSync(sourceDir, { recursive: true });
        mkdirSync(targetDir, { recursive: true });

        writeFileSync(join(sourceDir, "a-ok.js"), "console.log('ok');");
        writeFileSync(
          join(sourceDir, "b-locked.js"),
          "console.log('new content');"
        );

        const lockedTargetFile = join(targetDir, "b-locked.js");
        writeFileSync(lockedTargetFile, "console.log('locked old content');");
        chmodSync(lockedTargetFile, 0o444);

        const res = await runInstallerInChild(sourceDir, targetDir, workDir);
        assert.equal(
          res.exitCode,
          1,
          "Expected installer child to exit with code 1 on write error"
        );

        const errorMsg = res.messages.find((m) => m && m.type === "error");
        assert.ok(errorMsg, "Should emit structured { type: 'error' } message");
        assert.equal(errorMsg.code, "EACCES");
        assert.equal(errorMsg.total, 2);
        assert.equal(errorMsg.completed, 1);
        assert.ok(
          errorMsg.filePath.endsWith("b-locked.js"),
          `Expected filePath to point to b-locked.js, got ${errorMsg.filePath}`
        );
        assert.ok(
          res.messages.some(
            (m) =>
              typeof m === "string" && m.startsWith("installFailed:EACCES:")
          ),
          "Should also emit legacy installFailed: string message"
        );
        assert.ok(
          existsSync(join(workDir, "evdInstallerErrors.txt")),
          "Should write evdInstallerErrors.txt log file"
        );
      } finally {
        try {
          chmodSync(join(targetDir, "b-locked.js"), 0o644);
        } catch (_) {}
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  );

  console.log("\n=== 3. 最低支持版本解析、写入与远程生效校验测试 ===");

  await runTest(
    "resolveMinSupportedVersion: 参数优先级 (CLI > 配置 > 未声明)、三参数互斥、格式与上限校验",
    () => {
      assert.equal(
        JSON.stringify(resolveMinSupportedVersion({}, "2.0.0", {})),
        JSON.stringify({
          minSupportedVersion: undefined,
          source: "未声明",
          fromCLI: false,
        })
      );

      assert.equal(
        JSON.stringify(
          resolveMinSupportedVersion(
            { minSupportedVersion: "1.2.0" },
            "2.0.0",
            {}
          )
        ),
        JSON.stringify({
          minSupportedVersion: "1.2.0",
          source: "配置",
          fromCLI: false,
        })
      );

      assert.equal(
        JSON.stringify(
          resolveMinSupportedVersion(
            { minSupportedVersion: "1.2.0" },
            "2.0.0",
            { minSupportedVersion: "1.5.0" }
          )
        ),
        JSON.stringify({
          minSupportedVersion: "1.5.0",
          source: "CLI",
          fromCLI: true,
        })
      );

      assert.equal(
        JSON.stringify(
          resolveMinSupportedVersion(
            { minSupportedVersion: "1.2.0" },
            "2.0.0",
            { forceUpdate: true }
          )
        ),
        JSON.stringify({
          minSupportedVersion: "2.0.0",
          source: "CLI",
          fromCLI: true,
        })
      );

      assert.equal(
        JSON.stringify(
          resolveMinSupportedVersion(
            { minSupportedVersion: "1.2.0" },
            "2.0.0",
            { forceUpdate: false }
          )
        ),
        JSON.stringify({
          minSupportedVersion: undefined,
          source: "CLI",
          fromCLI: true,
        })
      );

      assert.throws(() =>
        resolveMinSupportedVersion({}, "2.0.0", {
          minSupportedVersion: "1.0.0",
          forceUpdate: true,
        })
      );
      assert.throws(() =>
        resolveMinSupportedVersion({}, "2.0.0", {
          minSupportedVersion: "1.0.0",
          forceUpdate: false,
        })
      );
      assert.throws(() =>
        resolveMinSupportedVersion({}, "2.0.0", {
          forceUpdate: true,
          noForceUpdate: true,
        })
      );

      for (const invalid of ["1.0", "v1.0.0", "1.0.0-beta.1", "abc", ""]) {
        assert.throws(() =>
          resolveMinSupportedVersion(
            { minSupportedVersion: invalid },
            "2.0.0",
            {}
          )
        );
      }

      assert.throws(() =>
        resolveMinSupportedVersion({}, "2.0.0", {
          minSupportedVersion: "2.0.1",
        })
      );
      assert.throws(() =>
        resolveMinSupportedVersion(
          { minSupportedVersion: "2.1.0" },
          "2.0.0",
          {}
        )
      );
    }
  );

  await runTest(
    "prepare & applyMinSupportedVersion: 写入 .evd/package.json、反复整形幂等、未声明删除该键、源与两个 zip 内 package.json 保持纯净",
    async () => {
      const prevCwd = process.cwd();
      const workDir = mkdtempSync(join(tmpdir(), "evd-prepare-minver-"));
      try {
        writeFileSync(
          join(workDir, "package.json"),
          JSON.stringify({ name: "host-workspace", version: "1.0.0" })
        );
        mkdirSync(join(workDir, "node_modules", ".evd"), { recursive: true });

        const appFolder = join(workDir, "compiled-app");
        mkdirSync(join(appFolder, "node_modules", "dep-a"), {
          recursive: true,
        });
        mkdirSync(join(appFolder, "dist"), { recursive: true });
        writeFileSync(
          join(appFolder, "node_modules", "dep-a", "index.js"),
          "module.exports = 1;"
        );
        writeFileSync(join(appFolder, "dist", "main.js"), "console.log(1);");
        const sourcePkgPath = join(appFolder, "package.json");
        writeFileSync(
          sourcePkgPath,
          JSON.stringify({ name: "my-electron-app", version: "2.0.0" })
        );

        process.chdir(workDir);

        await copySourceAndZipFiles({
          compileCommand: "build",
          changelogsPath: "CHANGELOG.md",
          sources: {
            folder: appFolder,
            nodeModules: "node_modules",
            codes: "dist",
            packageJSON: "package.json",
          },
          selfHosted: { url: "https://cdn.example.com/app" },
          minSupportedVersion: "1.2.0",
          prebuiltConfig: {},
        });

        const evdFolder = join(workDir, "node_modules", ".evd");
        const evdPkgPath = join(evdFolder, "package.json");
        const evdPkg = JSON.parse(readFileSync(evdPkgPath, "utf-8"));
        assert.equal(evdPkg.minSupportedVersion, "1.2.0");

        const sourcePkgAfter = JSON.parse(readFileSync(sourcePkgPath, "utf-8"));
        assert.equal("minSupportedVersion" in sourcePkgAfter, false);

        const unzipFull = join(workDir, "unzip-full");
        const unzipLogic = join(workDir, "unzip-logic");
        await extract(join(evdFolder, "fullCode.zip"), { dir: unzipFull });
        await extract(join(evdFolder, "logicCode.zip"), { dir: unzipLogic });

        const fullZipPkg = JSON.parse(
          readFileSync(join(unzipFull, "package.json"), "utf-8")
        );
        const logicZipPkg = JSON.parse(
          readFileSync(join(unzipLogic, "package.json"), "utf-8")
        );
        assert.equal("minSupportedVersion" in fullZipPkg, false);
        assert.equal("minSupportedVersion" in logicZipPkg, false);

        applyMinSupportedVersion(evdFolder, "2.0.0");
        assert.equal(
          JSON.parse(readFileSync(evdPkgPath, "utf-8")).minSupportedVersion,
          "2.0.0"
        );

        applyMinSupportedVersion(evdFolder, undefined);
        const clearedPkg = JSON.parse(readFileSync(evdPkgPath, "utf-8"));
        assert.equal("minSupportedVersion" in clearedPkg, false);

        applyMinSupportedVersion(evdFolder, undefined);
        const clearedAgainPkg = JSON.parse(readFileSync(evdPkgPath, "utf-8"));
        assert.equal("minSupportedVersion" in clearedAgainPkg, false);

        applyMinSupportedVersion(evdFolder, "1.5.0");
        assert.equal(
          JSON.parse(readFileSync(evdPkgPath, "utf-8")).minSupportedVersion,
          "1.5.0"
        );
      } finally {
        process.chdir(prevCwd);
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  );

  await runTest(
    "runDeployChecks: 降级门禁 (CLI 显式参数免确认 / 配置或未声明需确认或 --allow-min-version-downgrade / --force 放行但不写入)、同版本沿用 --allow-same-version、打印来源与交互式二次确认",
    async () => {
      const prevCwd = process.cwd();
      const workDir = mkdtempSync(join(tmpdir(), "evd-deploy-checks-"));
      let remotePkgPayload: any = {
        name: "my-electron-app",
        version: "1.9.0",
        minSupportedVersion: "1.5.0",
      };

      const server = createServer((req, res) => {
        if (req.url?.startsWith("/package.json")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(remotePkgPayload));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as any).port;
      const remoteUrl = `http://127.0.0.1:${port}`;

      try {
        writeFileSync(
          join(workDir, "package.json"),
          JSON.stringify({ name: "host-workspace", version: "1.0.0" })
        );
        const evdFolder = join(workDir, "node_modules", ".evd");
        mkdirSync(evdFolder, { recursive: true });
        const evdPkgPath = join(evdFolder, "package.json");
        writeFileSync(
          evdPkgPath,
          JSON.stringify({ name: "my-electron-app", version: "2.0.0" })
        );

        process.chdir(workDir);

        const makeConfigs = (minSupportedVersion?: string) => ({
          compileCommand: "build",
          changelogsPath: "CHANGELOG.md",
          sources: {
            folder: "dist",
            nodeModules: "node_modules",
            codes: "codes",
            packageJSON: "package.json",
          },
          selfHosted: { url: remoteUrl },
          ...(minSupportedVersion !== undefined
            ? { minSupportedVersion }
            : {}),
          prebuiltConfig: {},
        });

        const provider = getWhichProvider(makeConfigs());

        let downgradeErr: any;
        try {
          await runDeployChecks(
            makeConfigs("1.2.0"),
            provider,
            createCheckPolicy({ interactive: false })
          );
        } catch (err) {
          downgradeErr = err;
        }
        assert.ok(downgradeErr, "Should reject config minVersion downgrade");
        assert.ok(
          String(downgradeErr).includes("--allow-min-version-downgrade"),
          `Expected --allow-min-version-downgrade in error, got: ${downgradeErr}`
        );

        let unsetDowngradeErr: any;
        try {
          await runDeployChecks(
            makeConfigs(undefined),
            provider,
            createCheckPolicy({ interactive: false })
          );
        } catch (err) {
          unsetDowngradeErr = err;
        }
        assert.ok(
          unsetDowngradeErr,
          "Should reject undeclared minVersion when remote has minSupportedVersion"
        );
        assert.ok(
          String(unsetDowngradeErr).includes("--allow-min-version-downgrade")
        );

        await runDeployChecks(
          makeConfigs(undefined),
          provider,
          createCheckPolicy({
            interactive: false,
            allowMinVersionDowngrade: true,
          })
        );
        const pkgAfterForceAllow = JSON.parse(
          readFileSync(evdPkgPath, "utf-8")
        );
        assert.equal(
          "minSupportedVersion" in pkgAfterForceAllow,
          false,
          "--force / allowMinVersionDowngrade must not write minSupportedVersion when undeclared"
        );

        await runDeployChecks(
          makeConfigs("1.5.0"),
          provider,
          createCheckPolicy({ interactive: false }),
          { minSupportedVersion: "1.2.0" }
        );
        assert.equal(
          JSON.parse(readFileSync(evdPkgPath, "utf-8")).minSupportedVersion,
          "1.2.0",
          "Explicit CLI --min-supported-version downgrade should pass without --allow-min-version-downgrade"
        );

        await runDeployChecks(
          makeConfigs("1.5.0"),
          provider,
          createCheckPolicy({ interactive: false }),
          { forceUpdate: false }
        );
        assert.equal(
          "minSupportedVersion" in
            JSON.parse(readFileSync(evdPkgPath, "utf-8")),
          false,
          "Explicit CLI --no-force-update should pass without --allow-min-version-downgrade and remove key"
        );

        remotePkgPayload = {
          name: "my-electron-app",
          version: "2.0.0",
          minSupportedVersion: "1.5.0",
        };
        let sameVerErr: any;
        try {
          await runDeployChecks(
            makeConfigs("1.8.0"),
            provider,
            createCheckPolicy({ interactive: false })
          );
        } catch (err) {
          sameVerErr = err;
        }
        assert.ok(sameVerErr, "Same version must require --allow-same-version");
        assert.ok(String(sameVerErr).includes("--allow-same-version"));

        await runDeployChecks(
          makeConfigs("1.8.0"),
          provider,
          createCheckPolicy({ interactive: false, allowSameVersion: true })
        );
        assert.equal(
          JSON.parse(readFileSync(evdPkgPath, "utf-8")).minSupportedVersion,
          "1.8.0"
        );

        remotePkgPayload = {
          name: "my-electron-app",
          version: "1.9.0",
          minSupportedVersion: "1.8.0",
        };
        const promptedQuestions: string[] = [];
        const capturedLogs: string[] = [];
        const origLog = console.log;
        console.log = (...args: unknown[]) => {
          capturedLogs.push(args.map(String).join(" "));
          origLog(...args);
        };
        try {
          await runDeployChecks(
            makeConfigs("1.5.0"),
            provider,
            createCheckPolicy({
              interactive: true,
              confirm: async ({ message }) => {
                promptedQuestions.push(message);
                return true;
              },
            })
          );
        } finally {
          console.log = origLog;
        }

        assert.ok(
          capturedLogs.some(
            (l) => l.includes("1.5.0") && l.includes("配置")
          ),
          `Should log effective minSupportedVersion and source, got: ${capturedLogs.join(" | ")}`
        );
        assert.equal(
          promptedQuestions.length,
          2,
          `Expected 2 interactive prompts (downgrade + force update confirm), got: ${JSON.stringify(promptedQuestions)}`
        );
        assert.ok(
          promptedQuestions.some((q) =>
            q.includes("低于 1.5.0 的客户端将被强制更新")
          ),
          `Expected secondary confirm prompt, got: ${JSON.stringify(promptedQuestions)}`
        );
      } finally {
        process.chdir(prevCwd);
        server.close();
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  );

  await runTest(
    "verify runChecks: 比对 remote.minSupportedVersion ?? null 与本地值，不一致时输出「最低支持版本不一致，远程 X，本地 Y」",
    async () => {
      const prevCwd = process.cwd();
      const workDir = mkdtempSync(join(tmpdir(), "evd-verify-minver-"));
      let remotePkgPayload: any = {
        name: "my-electron-app",
        version: "2.0.0",
        minSupportedVersion: "1.0.0",
      };

      const server = createServer((req, res) => {
        if (req.url?.startsWith("/package.json")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(remotePkgPayload));
          return;
        }
        if (req.url?.startsWith("/changelog.json")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ version: "2.0.0", changes: "<p>ok</p>" }));
          return;
        }
        res.writeHead(200, { "Content-Length": "16" });
        res.end("ok");
      });

      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as any).port;
      const remoteUrl = `http://127.0.0.1:${port}`;

      try {
        writeFileSync(
          join(workDir, "package.json"),
          JSON.stringify({ name: "host-workspace", version: "1.0.0" })
        );
        mkdirSync(join(workDir, "node_modules", ".evd"), { recursive: true });
        process.chdir(workDir);

        const mismatchResults = await runChecks(
          remoteUrl,
          {
            name: "my-electron-app",
            version: "2.0.0",
            minSupportedVersion: "1.2.0",
          },
          5000
        );
        const pkgCheck1 = mismatchResults.find(
          (r) => r.label === "package.json"
        );
        assert.ok(pkgCheck1);
        assert.equal(pkgCheck1!.ok, false);
        assert.equal(
          pkgCheck1!.detail,
          "最低支持版本不一致，远程 1.0.0，本地 1.2.0"
        );

        remotePkgPayload = {
          name: "my-electron-app",
          version: "2.0.0",
        };
        const undeclaredRemoteResults = await runChecks(
          remoteUrl,
          {
            name: "my-electron-app",
            version: "2.0.0",
            minSupportedVersion: "1.2.0",
          },
          5000
        );
        const pkgCheck2 = undeclaredRemoteResults.find(
          (r) => r.label === "package.json"
        );
        assert.ok(pkgCheck2);
        assert.equal(pkgCheck2!.ok, false);
        assert.ok(
          pkgCheck2!.detail.startsWith("最低支持版本不一致，远程 ") &&
            pkgCheck2!.detail.endsWith("，本地 1.2.0"),
          `Unexpected detail: ${pkgCheck2!.detail}`
        );

        remotePkgPayload = {
          name: "my-electron-app",
          version: "2.0.0",
          minSupportedVersion: "1.2.0",
        };
        const matchResults = await runChecks(
          remoteUrl,
          {
            name: "my-electron-app",
            version: "2.0.0",
            minSupportedVersion: "1.2.0",
          },
          5000
        );
        assert.equal(
          matchResults.every((r) => r.ok),
          true
        );

        assert.throws(() =>
          resolveMinSupportedVersion(
            {},
            "2.0.0",
            extractMinVersionCLIOptions({ forceUpdate: false }, [
              "node",
              "evd",
              "preDeploy",
              "--force-update",
              "--no-force-update",
            ])
          )
        );

        writeFileSync(
          join(workDir, "evd.config.js"),
          `module.exports = ${JSON.stringify({
            compileCommand: "build",
            changelogsPath: "CHANGELOG.md",
            sources: {
              folder: "dist",
              nodeModules: "node_modules",
              codes: "codes",
              packageJSON: "package.json",
            },
            selfHosted: { url: remoteUrl },
            prebuiltConfig: {},
          })};`
        );
        writeFileSync(
          join(workDir, "node_modules", ".evd", "package.json"),
          JSON.stringify({
            name: "my-electron-app",
            version: "2.0.0",
            minSupportedVersion: "1.5.0",
          })
        );
        remotePkgPayload = {
          name: "my-electron-app",
          version: "2.0.0",
          minSupportedVersion: "1.2.0",
        };

        let pkgFetchCount = 0;
        server.on("request", (req) => {
          if (req.url?.startsWith("/package.json")) pkgFetchCount++;
        });

        const prevExitCode = process.exitCode;
        process.exitCode = 0;
        await program.parseAsync([
          "node",
          "evd",
          "verify",
          "--retry",
          "2",
          "--retry-delay",
          "0",
        ]);
        assert.equal(
          process.exitCode,
          1,
          "verify should set process.exitCode = 1 when minSupportedVersion mismatches after retries"
        );
        assert.equal(
          pkgFetchCount,
          2,
          "verify should retry --retry times on minSupportedVersion mismatch"
        );

        writeFileSync(
          join(workDir, "node_modules", ".evd", "fullCode.zip"),
          "dummy-zip"
        );
        remotePkgPayload = {
          name: "my-electron-app",
          version: "1.9.0",
          minSupportedVersion: "1.5.0",
        };

        process.exitCode = 0;
        await program.parseAsync([
          "node",
          "evd",
          "preDeploy",
          "--force-update",
        ]);
        assert.equal(process.exitCode, 0);
        assert.equal(
          JSON.parse(
            readFileSync(
              join(workDir, "node_modules", ".evd", "package.json"),
              "utf-8"
            )
          ).minSupportedVersion,
          "2.0.0"
        );

        process.exitCode = 0;
        await program.parseAsync([
          "node",
          "evd",
          "preDeploy",
          "--min-supported-version",
          "1.2.0",
        ]);
        assert.equal(process.exitCode, 0);
        assert.equal(
          JSON.parse(
            readFileSync(
              join(workDir, "node_modules", ".evd", "package.json"),
              "utf-8"
            )
          ).minSupportedVersion,
          "1.2.0"
        );

        process.exitCode = 0;
        await program.parseAsync([
          "node",
          "evd",
          "preDeploy",
          "--no-force-update",
        ]);
        assert.equal(process.exitCode, 0);
        assert.equal(
          "minSupportedVersion" in
            JSON.parse(
              readFileSync(
                join(workDir, "node_modules", ".evd", "package.json"),
                "utf-8"
              )
            ),
          false
        );

        process.exitCode = 0;
        await program.parseAsync([
          "node",
          "evd",
          "preDeploy",
          "--force-update",
          "--no-force-update",
        ]);
        assert.equal(
          process.exitCode,
          1,
          "Mutually exclusive flags should exit with code 1"
        );

        process.exitCode = prevExitCode;
      } finally {
        process.chdir(prevCwd);
        server.close();
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  );
}

main();
