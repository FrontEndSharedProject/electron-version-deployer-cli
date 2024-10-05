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
const { join, resolve, basename } = require("path");
const { dirname } = require("node:path");

try {
  copyFolderRecursiveSync("__unzipPath__", "__appPath__");
  process.parentPort.postMessage("exitManually");
  process.exit(0);
} catch (error) {
  appendFileSync(
    resolve(__dirname, "evdInstallerErrors.txt"),
    `
        ${new Date().toString()}\n
        ${error.toString()}\n
        -- stack\n
        ${error.stack}\n
        ----------------------------------------------------------------\n
      `
  );
  process.parentPort.postMessage("exitManually");
  process.exit(0);
}

// 复制文件夹及其内容的函数
function copyFolderRecursiveSync(source, target) {
  // 如果目标目录不存在，则创建目标目录
  if (!existsSync(target)) {
    mkdirSync(target);
  }

  // 获取源目录的文件列表
  const files = readdirSync(source);

  // 遍历文件列表，处理每个文件或子目录
  files.forEach((folderOrFile) => {
    const sourcePath = join(source, folderOrFile);
    const targetPath = join(target, folderOrFile);

    // 如果当前文件是文件夹，则递归复制文件夹
    if (statSync(sourcePath).isDirectory()) {
      if (folderOrFile === "node_modules") {
        replaceChangedModuleSync(sourcePath, targetPath);
      } else {
        copyFolderRecursiveSync(sourcePath, targetPath);
      }
    } else {
      // 否则，复制文件
      try {
        copyFileSync(sourcePath, targetPath);
      } catch (error) {
        appendFileSync(
          resolve(__dirname, "evdInstallerErrors.txt"),
          `
        ${new Date().toString()}\n
        ${error.toString()}\n
        -- stack\n
        ${error.stack}\n
        ----------------------------------------------------------------\n
      `
        );
      }
    }
  });
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

function replaceChangedModuleSync(
  sourceNodeModulesFolder,
  destNodeModulesFolder
) {
  //  读取 evdUnzip/node_modules 所有子文件
  const fileOrFolder = readdirSync(sourceNodeModulesFolder);

  // 遍历文件列表，处理每个文件或子目录
  fileOrFolder.forEach((folderOrFileName) => {
    const sourcePath = join(sourceNodeModulesFolder, folderOrFileName);
    const targetPath = join(destNodeModulesFolder, folderOrFileName);

    // 如果当前文件是文件夹，则判断是否要更新
    if (statSync(sourcePath).isDirectory()) {
      //  如果不存在，或者版本不一样则进行替换
      if (shouldReplaceModule(sourcePath, targetPath)) {
        copyFolderRecursiveSync(sourcePath, targetPath);
      }
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  });
}

function shouldReplaceModule(sourcePath, destPath) {
  const sourceVersion = getPackageVersion(sourcePath);
  const destVersion = getPackageVersion(destPath);
  return sourceVersion !== destVersion;
}

async function getPackageVersion(packagePath) {
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
