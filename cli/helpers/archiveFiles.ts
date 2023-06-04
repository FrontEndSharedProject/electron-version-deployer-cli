import { createWriteStream } from "node:fs";
import { basename } from "node:path";
import archiver from "archiver";
import { formatBytes } from "../utils";
import logSymbols from "log-symbols";

/**
 * 压缩文件到指定目录
 * @param outputPath
 * @param files
 */
export function archiveFiles(outputPath: string, files: string[]) {
  return new Promise<void>((res, rej) => {
    // 创建一个可写流来写入 zip 文件
    const output = createWriteStream(outputPath);
    const archive = archiver("zip");

    // 当打包完成时触发 'close' 事件
    output.on("close", function () {
      console.log(
        logSymbols.success,
        `压缩完成 ${basename(outputPath)} ${formatBytes(archive.pointer())}`
      );
      res();
    });

    // 当出现错误时触发 'error' 事件
    archive.on("error", function (err: any) {
      rej(err);
    });

    // 完成打包并关闭输出流
    archive.pipe(output);

    // 将指定文件夹添加到 zip 文件中
    for (let filePath of files) {
      if (~filePath.indexOf("package.json")) {
        archive.file(filePath, { name: basename(filePath) });
      } else {
        archive.directory(filePath, basename(filePath));
      }
    }

    archive.finalize();
  });
}
