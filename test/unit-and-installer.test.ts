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
}

main();
