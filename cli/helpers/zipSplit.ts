import { EVDConfigType } from "@/types/EVDConfigType";
import { join, sep } from "node:path";
import {
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import logSymbols from "log-symbols";
import { forceDeleteSync } from "@/utils/utils";
import { ProviderInterface } from "../commands/hostingProvider/ProviderInterface";

export const SPLIT_FOLDER_NAME = "fullCodeZipSplitZips";
export const FULL_CODE_ZIP_NAME = "fullCode.zip";

export type ZipSplitOptions = {
  enabled: boolean;
  thresholdMB: number;
  chunkSizeMB: number;
};

export function resolveZipSplitOptions(
  configs: EVDConfigType,
  provider: ProviderInterface,
  cliOverride?: boolean
): ZipSplitOptions {
  const zipSplit = configs.zipSplit ?? {};

  return {
    enabled: cliOverride ?? zipSplit.enabled ?? provider.defaultZipSplitEnabled,
    thresholdMB: zipSplit.thresholdMB ?? 24,
    chunkSizeMB: zipSplit.chunkSizeMB ?? 20,
  };
}

/**
 * 按需拆分 fullCode.zip
 * 已拆分过的目录重复执行不会报错
 */
export function applyZipSplit(folderPath: string, opts: ZipSplitOptions) {
  const fullCodeZipPath = join(folderPath, FULL_CODE_ZIP_NAME);
  const outputFolder = join(folderPath, SPLIT_FOLDER_NAME);
  const indexFilePath = join(outputFolder, "index.json");
  const alreadySplit =
    !existsSync(fullCodeZipPath) && existsSync(indexFilePath);

  if (!opts.enabled) {
    if (alreadySplit) {
      throw new Error(
        `node_modules/.evd 中的 ${FULL_CODE_ZIP_NAME} 已被拆分，无法再关闭拆分，请重新执行 evd prepare`
      );
    }

    //  残留的分片目录会让客户端误判为分片包，去下载并不存在的分片
    if (existsSync(outputFolder)) {
      rmSync(outputFolder, { force: true, maxRetries: 3, recursive: true });
      console.log(logSymbols.info, `已清理历史分片目录 ${SPLIT_FOLDER_NAME}`);
    }
    return;
  }

  if (alreadySplit) {
    console.log(
      logSymbols.info,
      `${FULL_CODE_ZIP_NAME} 已是分片状态，跳过拆分`
    );
    return;
  }

  if (!existsSync(fullCodeZipPath)) {
    throw new Error(`未找到 ${fullCodeZipPath}，请先执行 evd prepare`);
  }

  const fileSize = statSync(fullCodeZipPath).size;
  const fileSizeInMB = fileSize / (1024 * 1024);

  //  先清空该文件夹
  //  不然之前的文件夹还存在，再次部署时会出现更新旧文件夹问题
  if (existsSync(outputFolder)) {
    rmSync(outputFolder, { force: true, maxRetries: 3, recursive: true });
  }
  mkdirSync(outputFolder);

  if (fileSizeInMB < opts.thresholdMB) return;

  const chunkCount = Math.ceil(fileSizeInMB / opts.chunkSizeMB);
  const splitZipsFileName: string[] = [];

  const fileBuffer = readFileSync(fullCodeZipPath);
  const fileName = (fullCodeZipPath.split(sep).pop() as string).split(".");
  const fileExtension = fileName.pop();
  const baseFileName = fileName.join(".");

  for (let i = 0; i < chunkCount; i++) {
    const start = i * opts.chunkSizeMB * 1024 * 1024;
    const end = Math.min((i + 1) * opts.chunkSizeMB * 1024 * 1024, fileSize);
    const chunkBuffer = fileBuffer.slice(start, end);
    const chunkFileName = `${baseFileName}.part${i + 1}.${fileExtension}`;
    splitZipsFileName.push(chunkFileName);
    writeFileSync(join(outputFolder, chunkFileName), chunkBuffer);
  }

  //  写入描述文件
  writeFileSync(indexFilePath, JSON.stringify(splitZipsFileName));

  //  删除源文件
  forceDeleteSync(fullCodeZipPath);

  console.log(
    logSymbols.success,
    `${FULL_CODE_ZIP_NAME} 已拆分为 ${splitZipsFileName.length} 个分片`
  );
}
