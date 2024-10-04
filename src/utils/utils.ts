import fs from "fs";
import path from "path";

export function forceDeleteSync(targetPath) {
  try {
    const stats = fs.statSync(targetPath);

    if (stats.isDirectory()) {
      // 如果是目录，递归删除
      fs.chmodSync(targetPath, 0o777); // 赋予所有权限
      const files = fs.readdirSync(targetPath);
      for (const file of files) {
        forceDeleteSync(path.join(targetPath, file));
      }
      fs.rmdirSync(targetPath);
    } else {
      // 如果是文件，直接删除
      fs.chmodSync(targetPath, 0o666); // 赋予读写权限
      fs.unlinkSync(targetPath);
    }

    console.log(`成功删除: ${targetPath}`);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      console.log(`${targetPath} 不存在，无需删除`);
    } else {
      console.error(`删除 ${targetPath} 时发生错误:`, error);
    }
  }
}
