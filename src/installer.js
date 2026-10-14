//  该文件用于 fork 使用，将会写入到
//  app.getAppPath() + '/_evdInstallerTmp.js' 路径中
//  从避免 window 上替换时出现的资源占用问题
const {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
} = require("fs");
const { join, resolve, basename, relative } = require("path");

const SOURCE_ROOT = "__unzipPath__";
const TARGET_ROOT = "__appPath__";
const PROGRESS_THROTTLE_MS = 60;

let totalFiles = 0;
let completedFiles = 0;
let currentFilePath = "";
let lastProgressSentAt = 0;

try {
  const operations = collectCopyOperations(SOURCE_ROOT, TARGET_ROOT);
  totalFiles = operations.filter((op) => op.type === "file").length;
  postProgress(true);

  executeCopyOperations(operations);

  postProgress(true);
  process.parentPort.postMessage({
    type: "done",
    completed: completedFiles,
    total: totalFiles,
  });
  process.parentPort.postMessage("exitManually");
  setTimeout(() => process.exit(0), 50);
} catch (error) {
  logErrorToFile(error);
  const codePrefix = error && error.code ? error.code + ": " : "";
  const errMsg =
    codePrefix + (error && error.message ? error.message : String(error));
  process.parentPort.postMessage({
    type: "error",
    code: error && error.code,
    filePath: (error && (error.filePath || error.path)) || currentFilePath,
    completed: completedFiles,
    total: totalFiles,
    message: errMsg,
    stack: error && error.stack,
  });
  //  保留旧字符串格式兼容，等待 IPC 消息刷出后再以非 0 退出码退出
  process.parentPort.postMessage("installFailed:" + errMsg);
  setTimeout(() => process.exit(1), 50);
}

function logErrorToFile(error) {
  try {
    appendFileSync(
      resolve(__dirname, "evdInstallerErrors.txt"),
      `
        ${new Date().toString()}\n
        file: ${(error && (error.filePath || error.path)) || currentFilePath}\n
        ${error.toString()}\n
        -- stack\n
        ${error.stack}\n
        ----------------------------------------------------------------\n
      `
    );
  } catch (_) {}
}

function postProgress(force) {
  const now = Date.now();
  if (!force && now - lastProgressSentAt < PROGRESS_THROTTLE_MS) return;
  lastProgressSentAt = now;
  try {
    process.parentPort.postMessage({
      type: "progress",
      completed: completedFiles,
      total: totalFiles,
      currentFile: currentFilePath,
    });
  } catch (_) {}
}

// 单次遍历收集需要创建的目录与需要复制的文件，避免重复遍历与重复读取 package.json
function collectCopyOperations(
  source,
  target,
  isNodeModules = false,
  operations = []
) {
  if (!existsSync(source)) return operations;
  operations.push({ type: "dir", targetPath: target });

  const entries = readdirSync(source);
  entries.forEach((entryName) => {
    const sourcePath = join(source, entryName);
    const targetPath = join(target, entryName);

    if (statSync(sourcePath).isDirectory()) {
      if (isNodeModules) {
        if (entryName.startsWith("@")) {
          collectCopyOperations(sourcePath, targetPath, true, operations);
        } else if (shouldReplaceModule(sourcePath, targetPath)) {
          collectCopyOperations(sourcePath, targetPath, false, operations);
        }
      } else if (entryName === "node_modules") {
        collectCopyOperations(sourcePath, targetPath, true, operations);
      } else {
        collectCopyOperations(sourcePath, targetPath, false, operations);
      }
    } else {
      operations.push({ type: "file", sourcePath, targetPath });
    }
  });

  return operations;
}

function executeCopyOperations(operations) {
  operations.forEach((op) => {
    if (op.type === "dir") {
      if (!existsSync(op.targetPath)) {
        try {
          mkdirRecursiveSync(op.targetPath);
        } catch (error) {
          error.filePath = op.targetPath;
          throw error;
        }
      }
    } else {
      copySingleFileWithProgress(op.sourcePath, op.targetPath);
    }
  });
}

function copySingleFileWithProgress(sourcePath, targetPath) {
  currentFilePath = relative(SOURCE_ROOT, sourcePath) || basename(sourcePath);
  postProgress(completedFiles === 0);
  try {
    copyFileSync(sourcePath, targetPath);
    completedFiles += 1;
    postProgress(completedFiles === totalFiles);
  } catch (error) {
    error.filePath = targetPath;
    throw error;
  }
}

function copyFileSync(source, target) {
  let targetFile = target;

  if (existsSync(target)) {
    if (statSync(target).isDirectory()) {
      targetFile = join(target, basename(source));
    }
  }

  writeFileSync(targetFile, readFileSync(source));
}

function shouldReplaceModule(sourcePath, destPath) {
  const sourceVersion = getPackageVersion(sourcePath);
  const destVersion = getPackageVersion(destPath);
  return sourceVersion !== destVersion;
}

function getPackageVersion(packagePath) {
  try {
    const packageJsonPath = join(packagePath, "package.json");
    const packageJsonContent = readFileSync(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);
    return packageJson.version;
  } catch (error) {
    console.error(`Error reading package.json in ${packagePath}:`, error);
    return null;
  }
}

function mkdirRecursiveSync(targetPath) {
  mkdirSync(targetPath, { recursive: true });
}
