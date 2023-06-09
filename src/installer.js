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
const { join, resolve, basename } = require("node:path");

setTimeout(() => {
  try {
    copyFolderRecursiveSync("__unzipPath__", "__appPath__");
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
}, 1);

// 复制文件夹及其内容的函数
function copyFolderRecursiveSync(source, target) {
  // 如果目标目录不存在，则创建目标目录
  if (!existsSync(target)) {
    mkdirSync(target);
  }

  // 获取源目录的文件列表
  const files = readdirSync(source);

  // 遍历文件列表，处理每个文件或子目录
  files.forEach((file) => {
    const sourcePath = join(source, file);
    const targetPath = join(target, file);

    // 如果当前文件是文件夹，则递归复制文件夹
    if (statSync(sourcePath).isDirectory()) {
      copyFolderRecursiveSync(sourcePath, targetPath);
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
