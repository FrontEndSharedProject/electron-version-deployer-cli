import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
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
import { versionToNum } from "@/utils/versionToNum";
import { forceDeleteSync } from "@/utils/utils";
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
import {
  applyZipSplit,
  extractZipSplitCLIOverride,
  FULL_CODE_ZIP_NAME,
  LOGIC_CODE_ZIP_NAME,
  LOGIC_SPLIT_FOLDER_NAME,
  resolveZipSplitOptions,
  SPLIT_FOLDER_NAME,
} from "../cli/helpers/zipSplit";
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
      "detectUpdateEnvironment: 真实只读 DMG 卷 (EROFS) -> READ_ONLY_VOLUME，/Volumes/ 下可写目录正常通过",
      () => {
        const workDir = mkdtempSync(join(tmpdir(), "evd-volumes-"));
        let mountPoint = "";
        try {
          const bootVolumeName = readdirSync("/Volumes").find((name) => {
            try {
              return realpathSync(join("/Volumes", name)) === "/";
            } catch (_) {
              return false;
            }
          });
          if (bootVolumeName) {
            detectUpdateEnvironment(
              join("/Volumes", bootVolumeName, realpathSync(workDir))
            );
          }

          const dmgPath = join(workDir, "evd-readonly.dmg");
          execFileSync(
            "hdiutil",
            [
              "create",
              "-size",
              "2m",
              "-fs",
              "HFS+",
              "-volname",
              "EVDReadOnlyTest",
              dmgPath,
            ],
            { stdio: "ignore" }
          );
          const attachOutput = execFileSync(
            "hdiutil",
            ["attach", "-readonly", "-nobrowse", dmgPath],
            { encoding: "utf-8" }
          );
          mountPoint = (
            attachOutput.trim().split("\n").pop()?.split("\t").pop() ?? ""
          ).trim();
          assert.ok(
            mountPoint.startsWith("/Volumes/"),
            `Unexpected mount point: ${mountPoint}`
          );

          assert.throws(
            () => detectUpdateEnvironment(mountPoint),
            (err: unknown) => {
              assert.ok(isEVDError(err));
              assert.equal(err.code, EVDErrorCodeEnum.READ_ONLY_VOLUME);
              assert.equal(err.phase, EVDErrorPhaseEnum.INSTALL);
              assert.equal(err.filePath, mountPoint);
              assert.ok(err.message.includes("DMG 安装镜像"));
              return true;
            }
          );
        } finally {
          if (mountPoint) {
            try {
              execFileSync("hdiutil", ["detach", mountPoint, "-force"], {
                stdio: "ignore",
              });
            } catch (_) {}
          }
          rmSync(workDir, { recursive: true, force: true });
        }
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

        mkdirSync(join(sourceDir, "extra-assets", "nested"), {
          recursive: true,
        });
        writeFileSync(
          join(sourceDir, "extra-assets", "config.json"),
          '{"v":2}'
        );
        writeFileSync(
          join(sourceDir, "extra-assets", "nested", "added.txt"),
          "new-extra-file"
        );

        mkdirSync(join(targetDir, "node_modules", "unchanged-pkg"), {
          recursive: true,
        });
        mkdirSync(join(targetDir, "node_modules", "updated-pkg"), {
          recursive: true,
        });
        mkdirSync(join(targetDir, "extra-assets"), {
          recursive: true,
        });
        writeFileSync(
          join(targetDir, "extra-assets", "config.json"),
          '{"v":1}'
        );
        writeFileSync(
          join(targetDir, "extra-assets", "legacy.txt"),
          "keep-me"
        );
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
          8,
          "Pre-counted total files should be 8 (skipping unchanged-pkg, including extra-assets)"
        );
        assert.ok(doneMsg, "Should emit done message");
        assert.equal(doneMsg.completed, 8);
        assert.equal(doneMsg.total, 8);
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
        assert.equal(
          readFileSync(join(targetDir, "extra-assets", "config.json"), "utf-8"),
          '{"v":2}'
        );
        assert.equal(
          readFileSync(
            join(targetDir, "extra-assets", "nested", "added.txt"),
            "utf-8"
          ),
          "new-extra-file"
        );
        assert.equal(
          readFileSync(join(targetDir, "extra-assets", "legacy.txt"), "utf-8"),
          "keep-me"
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
        res.writeHead(200, { "Content-Length": "2" });
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

  await runTest(
    "prepare & extraFolders: 支持数组/同步函数/异步函数与相对/绝对路径、编译后解析、打入双 zip、清理残留裸目录、移除 deployChecks 裸复制及非法/冲突路径报错",
    async () => {
      const prevCwd = process.cwd();
      const workDir = mkdtempSync(join(tmpdir(), "evd-extra-folders-"));
      try {
        writeFileSync(
          join(workDir, "package.json"),
          JSON.stringify({
            name: "host-workspace",
            version: "1.0.0",
            scripts: {
              build:
                "node -e \"const fs=require('fs');fs.mkdirSync('compiled-extra',{recursive:true});fs.writeFileSync('compiled-extra/from-build.txt','built-ok');\"",
            },
          })
        );
        writeFileSync(
          join(workDir, "CHANGELOG.md"),
          "# Changelog\n\n## [2.0.0] - 2026-10-14\n\n- Support extraFolders hot update\n"
        );
        const evdFolder = join(workDir, "node_modules", ".evd");
        mkdirSync(evdFolder, { recursive: true });

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
        writeFileSync(
          join(appFolder, "package.json"),
          JSON.stringify({ name: "my-electron-app", version: "2.0.0" })
        );

        const relExtraDir = join(workDir, "public", "static-assets");
        mkdirSync(join(relExtraDir, "nested"), { recursive: true });
        writeFileSync(join(relExtraDir, "logo.svg"), "<svg/>");
        writeFileSync(join(relExtraDir, "nested", "data.json"), '{"ok":true}');

        const absExtraDir = join(workDir, "external-resources", "themes");
        mkdirSync(absExtraDir, { recursive: true });
        writeFileSync(join(absExtraDir, "dark.css"), "body{color:#fff}");

        const staleRawDir = join(evdFolder, "static-assets");
        mkdirSync(staleRawDir, { recursive: true });
        writeFileSync(join(staleRawDir, "stale.txt"), "stale");

        const staleFullSplitDir = join(evdFolder, SPLIT_FOLDER_NAME);
        const staleLogicSplitDir = join(evdFolder, LOGIC_SPLIT_FOLDER_NAME);
        mkdirSync(staleFullSplitDir, { recursive: true });
        mkdirSync(staleLogicSplitDir, { recursive: true });
        writeFileSync(
          join(staleFullSplitDir, "index.json"),
          '["fullCode.part1.zip"]'
        );
        writeFileSync(
          join(staleLogicSplitDir, "index.json"),
          '["logicCode.part1.zip"]'
        );

        process.chdir(workDir);

        const baseConfigs = {
          compileCommand: "build",
          changelogsPath: "CHANGELOG.md",
          sources: {
            folder: appFolder,
            nodeModules: "node_modules",
            codes: "dist",
            packageJSON: "package.json",
          },
          selfHosted: { url: "https://cdn.example.com/app" },
          prebuiltConfig: {},
        };

        await copySourceAndZipFiles({
          ...baseConfigs,
          extraFolders: ["public/static-assets", absExtraDir],
        });

        assert.equal(
          existsSync(staleRawDir),
          false,
          "Stale raw folder in node_modules/.evd/<basename> should be cleaned up"
        );
        assert.equal(
          existsSync(staleFullSplitDir),
          false,
          "Stale fullCodeZipSplitZips in node_modules/.evd/ should be cleaned up by prepare"
        );
        assert.equal(
          existsSync(staleLogicSplitDir),
          false,
          "Stale logicCodeZipSplitZips in node_modules/.evd/ should be cleaned up by prepare"
        );

        const unzipFull1 = join(workDir, "unzip-full-1");
        const unzipLogic1 = join(workDir, "unzip-logic-1");
        await extract(join(evdFolder, "fullCode.zip"), { dir: unzipFull1 });
        await extract(join(evdFolder, "logicCode.zip"), { dir: unzipLogic1 });

        for (const unzipDir of [unzipFull1, unzipLogic1]) {
          assert.equal(
            readFileSync(
              join(unzipDir, "static-assets", "logo.svg"),
              "utf-8"
            ),
            "<svg/>"
          );
          assert.equal(
            readFileSync(
              join(unzipDir, "static-assets", "nested", "data.json"),
              "utf-8"
            ),
            '{"ok":true}'
          );
          assert.equal(
            readFileSync(join(unzipDir, "themes", "dark.css"), "utf-8"),
            "body{color:#fff}"
          );
        }

        await copySourceAndZipFiles({
          ...baseConfigs,
          extraFolders: () => ["public/static-assets"],
        });
        const unzipSyncFn = join(workDir, "unzip-sync-fn");
        await extract(join(evdFolder, "logicCode.zip"), { dir: unzipSyncFn });
        assert.equal(
          readFileSync(join(unzipSyncFn, "static-assets", "logo.svg"), "utf-8"),
          "<svg/>"
        );
        assert.equal(existsSync(join(unzipSyncFn, "themes")), false);

        await copySourceAndZipFiles({
          ...baseConfigs,
          extraFolders: async () => [absExtraDir],
        });
        const unzipAsyncFn = join(workDir, "unzip-async-fn");
        await extract(join(evdFolder, "logicCode.zip"), { dir: unzipAsyncFn });
        assert.equal(
          readFileSync(join(unzipAsyncFn, "themes", "dark.css"), "utf-8"),
          "body{color:#fff}"
        );

        await copySourceAndZipFiles({
          ...baseConfigs,
          extraFolders: [],
        });

        writeFileSync(
          join(workDir, "evd.config.js"),
          `module.exports = {
            compileCommand: "build",
            changelogsPath: "CHANGELOG.md",
            sources: {
              folder: ${JSON.stringify(appFolder)},
              nodeModules: "node_modules",
              codes: "dist",
              packageJSON: "package.json",
            },
            extraFolders: () => {
              const fs = require("fs");
              if (!fs.existsSync("compiled-extra/from-build.txt")) {
                throw new Error("extraFolders called before compileCommand!");
              }
              return ["compiled-extra"];
            },
            selfHosted: { url: "https://cdn.example.com/app" },
            prebuiltConfig: {},
          };`
        );

        const prevExitCode = process.exitCode;
        process.exitCode = 0;
        await program.parseAsync(["node", "evd", "prepare"]);
        assert.equal(process.exitCode, 0);

        const unzipPrepare = join(workDir, "unzip-prepare");
        await extract(join(evdFolder, "logicCode.zip"), { dir: unzipPrepare });
        assert.equal(
          readFileSync(
            join(unzipPrepare, "compiled-extra", "from-build.txt"),
            "utf-8"
          ),
          "built-ok"
        );

        const server = createServer((req, res) => {
          if (req.url?.startsWith("/package.json")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ name: "my-electron-app", version: "1.9.0" })
            );
            return;
          }
          res.writeHead(404);
          res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const port = (server.address() as any).port;
        try {
          const checkConfigs = {
            ...baseConfigs,
            selfHosted: { url: `http://127.0.0.1:${port}` },
            extraFolders: ["public/static-assets"],
          };
          await runDeployChecks(
            checkConfigs,
            getWhichProvider(checkConfigs),
            createCheckPolicy({ interactive: false })
          );
          assert.equal(
            existsSync(join(evdFolder, "static-assets")),
            false,
            "runDeployChecks should not copy raw extraFolders into .evd"
          );
        } finally {
          server.close();
        }

        const fileNotDir = join(workDir, "single-file.txt");
        writeFileSync(fileNotDir, "hello");
        const dupDirA = join(workDir, "dup-a", "same-name");
        const dupDirB = join(workDir, "dup-b", "same-name");
        mkdirSync(dupDirA, { recursive: true });
        mkdirSync(dupDirB, { recursive: true });
        const collideCodes = join(workDir, "collide", "dist");
        const collideNodeModules = join(workDir, "collide", "node_modules");
        const collidePkgJson = join(workDir, "collide", "package.json");
        mkdirSync(collideCodes, { recursive: true });
        mkdirSync(collideNodeModules, { recursive: true });
        mkdirSync(collidePkgJson, { recursive: true });

        for (const invalidExtra of [
          ["non-existent-folder"],
          ["single-file.txt"],
          [dupDirA, dupDirB],
          [collideCodes],
          [collideNodeModules],
          [collidePkgJson],
        ]) {
          let caught: unknown = null;
          try {
            await copySourceAndZipFiles({
              ...baseConfigs,
              extraFolders: invalidExtra,
            });
          } catch (err) {
            caught = err;
          }
          assert.ok(
            caught instanceof Error,
            `Expected error for extraFolders=${JSON.stringify(invalidExtra)}`
          );
        }

        writeFileSync(
          join(workDir, "evd.config.js"),
          `module.exports = ${JSON.stringify({
            ...baseConfigs,
            extraFolders: ["non-existent-folder"],
          })};`
        );
        process.exitCode = 0;
        await program.parseAsync(["node", "evd", "prepare"]);
        assert.equal(
          process.exitCode,
          1,
          "evd prepare should set process.exitCode = 1 when extraFolders validation fails"
        );
        process.exitCode = prevExitCode;
      } finally {
        process.chdir(prevCwd);
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  );

  await runTest(
    "zipSplit: fullCode.zip 与 logicCode.zip 独立按阈值分片、未达阈值或禁用时清理残留分片目录且不留空目录、重复执行幂等、已拆分后关闭分片报错",
    () => {
      const workDir = mkdtempSync(join(tmpdir(), "evd-zipsplit-"));
      try {
        assert.equal(SPLIT_FOLDER_NAME, "fullCodeZipSplitZips");
        assert.equal(FULL_CODE_ZIP_NAME, "fullCode.zip");
        assert.equal(LOGIC_SPLIT_FOLDER_NAME, "logicCodeZipSplitZips");
        assert.equal(LOGIC_CODE_ZIP_NAME, "logicCode.zip");

        const smallBuf = Buffer.alloc(512 * 1024, 0x41);
        const largeBuf = Buffer.alloc(2.5 * 1024 * 1024, 0x42);

        const case1Dir = join(workDir, "case1");
        mkdirSync(join(case1Dir, LOGIC_SPLIT_FOLDER_NAME), { recursive: true });
        writeFileSync(
          join(case1Dir, LOGIC_SPLIT_FOLDER_NAME, "index.json"),
          '["logicCode.part1.zip"]'
        );
        writeFileSync(join(case1Dir, FULL_CODE_ZIP_NAME), largeBuf);
        writeFileSync(join(case1Dir, LOGIC_CODE_ZIP_NAME), smallBuf);

        applyZipSplit(case1Dir, {
          enabled: true,
          thresholdMB: 2,
          chunkSizeMB: 1,
        });

        assert.equal(existsSync(join(case1Dir, FULL_CODE_ZIP_NAME)), false);
        const fullIndex1 = JSON.parse(
          readFileSync(
            join(case1Dir, SPLIT_FOLDER_NAME, "index.json"),
            "utf-8"
          )
        );
        assert.equal(
          JSON.stringify(fullIndex1),
          JSON.stringify([
            "fullCode.part1.zip",
            "fullCode.part2.zip",
            "fullCode.part3.zip",
          ])
        );
        assert.equal(existsSync(join(case1Dir, LOGIC_CODE_ZIP_NAME)), true);
        assert.equal(
          existsSync(join(case1Dir, LOGIC_SPLIT_FOLDER_NAME)),
          false,
          "Below-threshold logicCode must not leave stale or empty logicCodeZipSplitZips folder"
        );

        const case2Dir = join(workDir, "case2");
        mkdirSync(join(case2Dir, SPLIT_FOLDER_NAME), { recursive: true });
        writeFileSync(
          join(case2Dir, SPLIT_FOLDER_NAME, "index.json"),
          '["fullCode.part1.zip"]'
        );
        writeFileSync(join(case2Dir, FULL_CODE_ZIP_NAME), smallBuf);
        writeFileSync(join(case2Dir, LOGIC_CODE_ZIP_NAME), largeBuf);

        applyZipSplit(case2Dir, {
          enabled: true,
          thresholdMB: 2,
          chunkSizeMB: 1,
        });

        assert.equal(existsSync(join(case2Dir, FULL_CODE_ZIP_NAME)), true);
        assert.equal(
          existsSync(join(case2Dir, SPLIT_FOLDER_NAME)),
          false,
          "Below-threshold fullCode must not leave stale or empty fullCodeZipSplitZips folder"
        );
        assert.equal(existsSync(join(case2Dir, LOGIC_CODE_ZIP_NAME)), false);
        const logicIndex2 = JSON.parse(
          readFileSync(
            join(case2Dir, LOGIC_SPLIT_FOLDER_NAME, "index.json"),
            "utf-8"
          )
        );
        assert.equal(
          JSON.stringify(logicIndex2),
          JSON.stringify([
            "logicCode.part1.zip",
            "logicCode.part2.zip",
            "logicCode.part3.zip",
          ])
        );
        const mergedLogic2 = Buffer.concat(
          logicIndex2.map((part: string) =>
            readFileSync(join(case2Dir, LOGIC_SPLIT_FOLDER_NAME, part))
          )
        );
        assert.equal(mergedLogic2.equals(largeBuf), true);

        applyZipSplit(case2Dir, {
          enabled: true,
          thresholdMB: 2,
          chunkSizeMB: 1,
        });
        assert.equal(existsSync(join(case2Dir, LOGIC_CODE_ZIP_NAME)), false);
        assert.equal(
          existsSync(join(case2Dir, LOGIC_SPLIT_FOLDER_NAME, "index.json")),
          true
        );

        assert.throws(
          () =>
            applyZipSplit(case1Dir, {
              enabled: false,
              thresholdMB: 2,
              chunkSizeMB: 1,
            }),
          (err) => String(err).includes(FULL_CODE_ZIP_NAME)
        );
        assert.throws(
          () =>
            applyZipSplit(case2Dir, {
              enabled: false,
              thresholdMB: 2,
              chunkSizeMB: 1,
            }),
          (err) => String(err).includes(LOGIC_CODE_ZIP_NAME)
        );

        const case3Dir = join(workDir, "case3");
        mkdirSync(join(case3Dir, SPLIT_FOLDER_NAME), { recursive: true });
        mkdirSync(join(case3Dir, LOGIC_SPLIT_FOLDER_NAME), { recursive: true });
        writeFileSync(
          join(case3Dir, SPLIT_FOLDER_NAME, "index.json"),
          '["fullCode.part1.zip"]'
        );
        writeFileSync(
          join(case3Dir, LOGIC_SPLIT_FOLDER_NAME, "index.json"),
          '["logicCode.part1.zip"]'
        );
        writeFileSync(join(case3Dir, FULL_CODE_ZIP_NAME), smallBuf);
        writeFileSync(join(case3Dir, LOGIC_CODE_ZIP_NAME), smallBuf);

        applyZipSplit(case3Dir, {
          enabled: false,
          thresholdMB: 2,
          chunkSizeMB: 1,
        });
        assert.equal(existsSync(join(case3Dir, SPLIT_FOLDER_NAME)), false);
        assert.equal(
          existsSync(join(case3Dir, LOGIC_SPLIT_FOLDER_NAME)),
          false
        );
        assert.equal(existsSync(join(case3Dir, FULL_CODE_ZIP_NAME)), true);
        assert.equal(existsSync(join(case3Dir, LOGIC_CODE_ZIP_NAME)), true);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  );

  await runTest(
    "verify runChecks: 当本地存在 logicCodeZipSplitZips/index.json 时校验远程增量分片索引及各分片文件",
    async () => {
      const prevCwd = process.cwd();
      const workDir = mkdtempSync(join(tmpdir(), "evd-verify-logicsplit-"));
      let missingChunk: string | null = null;
      const requestedPaths: string[] = [];

      const server = createServer((req, res) => {
        const urlPath = (req.url || "").split("?")[0];
        requestedPaths.push(urlPath);
        if (urlPath === "/package.json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ name: "my-electron-app", version: "2.0.0" })
          );
          return;
        }
        if (urlPath === "/changelog.json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ version: "2.0.0", changes: "<p>ok</p>" }));
          return;
        }
        if (urlPath === "/logicCodeZipSplitZips/index.json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(["logicCode.part1.zip", "logicCode.part2.zip"])
          );
          return;
        }
        if (urlPath === "/logicCode.zip") {
          res.writeHead(404);
          res.end();
          return;
        }
        if (missingChunk && urlPath === missingChunk) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Length": "1024" });
        res.end(Buffer.alloc(1024));
      });

      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as any).port;
      const remoteUrl = `http://127.0.0.1:${port}`;

      try {
        writeFileSync(
          join(workDir, "package.json"),
          JSON.stringify({ name: "host-workspace", version: "1.0.0" })
        );
        const localLogicSplitDir = join(
          workDir,
          "node_modules",
          ".evd",
          LOGIC_SPLIT_FOLDER_NAME
        );
        mkdirSync(localLogicSplitDir, { recursive: true });
        writeFileSync(
          join(localLogicSplitDir, "index.json"),
          JSON.stringify(["logicCode.part1.zip", "logicCode.part2.zip"])
        );
        process.chdir(workDir);

        const okResults = await runChecks(
          remoteUrl,
          { name: "my-electron-app", version: "2.0.0" },
          5000
        );
        assert.equal(
          okResults.every((r) => r.ok),
          true,
          `Expected all checks to pass, got: ${JSON.stringify(okResults)}`
        );
        assert.equal(
          requestedPaths.includes("/logicCode.zip"),
          false,
          "Should not probe /logicCode.zip when local logicCodeZipSplitZips/index.json exists"
        );
        assert.ok(
          okResults.some(
            (r) =>
              r.label === "logicCodeZipSplitZips/index.json" &&
              r.ok &&
              r.detail === "2 个分片"
          )
        );
        assert.ok(
          okResults.some(
            (r) =>
              r.label === "logicCodeZipSplitZips/logicCode.part1.zip" && r.ok
          )
        );
        assert.ok(
          okResults.some(
            (r) =>
              r.label === "logicCodeZipSplitZips/logicCode.part2.zip" && r.ok
          )
        );

        missingChunk = "/logicCodeZipSplitZips/logicCode.part2.zip";
        const failResults = await runChecks(
          remoteUrl,
          { name: "my-electron-app", version: "2.0.0" },
          5000
        );
        const part2Check = failResults.find(
          (r) => r.label === "logicCodeZipSplitZips/logicCode.part2.zip"
        );
        assert.ok(part2Check);
        assert.equal(part2Check!.ok, false);
      } finally {
        process.chdir(prevCwd);
        server.close();
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  );

  await runTest(
    "verify runChecks: 本地未分片时远程残留分片清单判失败，本地已分片时远程分片清单与本地不一致判失败",
    async () => {
      const prevCwd = process.cwd();
      const workDir = mkdtempSync(join(tmpdir(), "evd-verify-stale-split-"));
      let remoteLogicIndex: string[] | null = ["logicCode.part1.zip"];
      let remoteFullIndex: string[] | null = null;

      const server = createServer((req, res) => {
        const urlPath = (req.url || "").split("?")[0];
        const sendJSON = (payload: unknown) => {
          const body = JSON.stringify(payload);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          });
          res.end(body);
        };
        if (urlPath === "/package.json") {
          return sendJSON({ name: "my-electron-app", version: "2.0.0" });
        }
        if (urlPath === "/changelog.json") {
          return sendJSON({ version: "2.0.0" });
        }
        if (urlPath === "/logicCodeZipSplitZips/index.json") {
          if (remoteLogicIndex) return sendJSON(remoteLogicIndex);
          res.writeHead(404);
          res.end();
          return;
        }
        if (urlPath === "/fullCodeZipSplitZips/index.json") {
          if (remoteFullIndex) return sendJSON(remoteFullIndex);
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Length": "4" });
        res.end("data");
      });

      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const remoteUrl = `http://127.0.0.1:${(server.address() as any).port}`;
      const localPKG = { name: "my-electron-app", version: "2.0.0" };

      try {
        writeFileSync(
          join(workDir, "package.json"),
          JSON.stringify({ name: "host-workspace", version: "1.0.0" })
        );
        mkdirSync(join(workDir, "node_modules", ".evd"), { recursive: true });
        process.chdir(workDir);

        const staleResults = await runChecks(remoteUrl, localPKG, 5000);
        const staleLogicCheck = staleResults.find(
          (r) => r.label === "logicCodeZipSplitZips/index.json"
        );
        assert.ok(staleLogicCheck);
        assert.equal(staleLogicCheck!.ok, false);
        assert.ok(
          staleLogicCheck!.detail.includes("远程残留历史分片清单"),
          `Unexpected detail: ${staleLogicCheck!.detail}`
        );
        assert.equal(
          staleResults.find((r) => r.label === "logicCode.zip")?.ok,
          true
        );
        assert.equal(
          staleResults.find((r) => r.label === "fullCodeZipSplitZips/index.json")
            ?.ok,
          true
        );

        remoteLogicIndex = [];
        const emptyIndexResults = await runChecks(remoteUrl, localPKG, 5000);
        assert.equal(
          emptyIndexResults.every((r) => r.ok),
          true,
          `Empty remote split index should be ignored like the client does: ${JSON.stringify(
            emptyIndexResults
          )}`
        );

        remoteLogicIndex = null;
        const localFullSplitDir = join(
          workDir,
          "node_modules",
          ".evd",
          SPLIT_FOLDER_NAME
        );
        mkdirSync(localFullSplitDir, { recursive: true });
        writeFileSync(
          join(localFullSplitDir, "index.json"),
          JSON.stringify(["fullCode.part1.zip"])
        );
        remoteFullIndex = ["fullCode.part1.zip", "fullCode.part2.zip"];
        const mismatchResults = await runChecks(remoteUrl, localPKG, 5000);
        const fullIndexCheck = mismatchResults.find(
          (r) => r.label === "fullCodeZipSplitZips/index.json"
        );
        assert.ok(fullIndexCheck);
        assert.equal(fullIndexCheck!.ok, false);
        assert.equal(
          fullIndexCheck!.detail,
          "与本地分片清单不一致，远程 2 个分片，本地 1 个分片"
        );

        remoteFullIndex = ["fullCode.part1.zip"];
        const okResults = await runChecks(remoteUrl, localPKG, 5000);
        assert.equal(
          okResults.every((r) => r.ok),
          true,
          `Expected all checks to pass, got: ${JSON.stringify(okResults)}`
        );
        assert.ok(
          okResults.some(
            (r) => r.label === "fullCodeZipSplitZips/fullCode.part1.zip" && r.ok
          )
        );
      } finally {
        process.chdir(prevCwd);
        server.close();
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  );

  await runTest(
    "versionToNum & extractZipSplitCLIOverride & forceDeleteSync: 5+ 位版本段比较、--split/--no-split 互斥与状态隔离、软链安全删除",
    () => {
      assert.equal(
        versionToNum("1.0.10000").includes("undefined"),
        false,
        "5+ digit version segments must not contain undefined"
      );
      assert.equal(
        versionToNum("1.0.10000") > versionToNum("1.0.9999"),
        true
      );
      assert.equal(
        versionToNum("1.0.100000") > versionToNum("1.0.20000"),
        true
      );

      assert.equal(
        extractZipSplitCLIOverride({ split: true }, ["node", "evd", "preDeploy"]),
        undefined,
        "Stale Commander options.split should be ignored when rawArgs has neither --split nor --no-split"
      );
      assert.equal(
        extractZipSplitCLIOverride({}, ["node", "evd", "preDeploy", "--split"]),
        true
      );
      assert.equal(
        extractZipSplitCLIOverride({}, [
          "node",
          "evd",
          "preDeploy",
          "--no-split",
        ]),
        false
      );
      assert.throws(() =>
        extractZipSplitCLIOverride({}, [
          "node",
          "evd",
          "preDeploy",
          "--split",
          "--no-split",
        ])
      );

      const tempDir = mkdtempSync(join(tmpdir(), "evd-symlink-del-"));
      try {
        const realDir = join(tempDir, "real-dir");
        mkdirSync(realDir, { recursive: true });
        const keptFile = join(realDir, "keep.txt");
        writeFileSync(keptFile, "keep");

        const linkToDir = join(tempDir, "link-to-dir");
        symlinkSync(realDir, linkToDir, "dir");
        forceDeleteSync(linkToDir);
        assert.equal(existsSync(linkToDir), false);
        assert.equal(
          existsSync(keptFile),
          true,
          "forceDeleteSync on a directory symlink must not delete files inside the target directory"
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );
}

main();

