import { EVDConfigType } from "@/types/EVDConfigType";
import { platform } from "node:os";
import { spawn } from "node:child_process";
import logSymbols from "log-symbols";
import { ProviderInterface } from "./ProviderInterface";
import { join, sep } from "node:path";
import {
  statSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";

export class Cloudflare implements ProviderInterface {
  private static _instance: Cloudflare;
  public static get instance(): Cloudflare {
    if (!this._instance) {
      this._instance = new Cloudflare();
    }

    return this._instance;
  }

  getUrl(configs: EVDConfigType): string {
    return configs.cloudflare?.url as string;
  }

  //  由于 cloudflare 限制了文件最大只能为 25m
  //  判断文件夹下面的 fullCode.zip 是否超过 25m 如果超过就进行分割
  splitFileIfNeed(folderPath: string) {
    const fullCodeZipPath = join(folderPath, "fullCode.zip");
    const fileStats = statSync(fullCodeZipPath);
    const fileSize = fileStats.size;
    const fileSizeInMB = fileSize / (1024 * 1024);
    const outputFolder = join(folderPath, "fullCodeZipSplitZips");

    !existsSync(outputFolder) && mkdirSync(outputFolder);

    if (fileSizeInMB < 24) return;

    //  按照 20m 分割
    const SPLIT_SIZE = 20;
    const chunkCount = Math.ceil(fileSizeInMB / SPLIT_SIZE);
    const splitZipsFileName: string[] = [];

    const fileBuffer = readFileSync(fullCodeZipPath);
    const fileName = (fullCodeZipPath.split(sep).pop() as string).split(".");
    const fileExtension = fileName.pop();
    const baseFileName = fileName.join(".");

    for (let i = 0; i < chunkCount; i++) {
      const start = i * SPLIT_SIZE * 1024 * 1024;
      const end = Math.min((i + 1) * SPLIT_SIZE * 1024 * 1024, fileSize);
      const chunkBuffer = fileBuffer.slice(start, end);
      const chunkFileName = `${baseFileName}.part${i + 1}.${fileExtension}`;
      splitZipsFileName.push(chunkFileName);
      writeFileSync(join(outputFolder, chunkFileName), chunkBuffer);
    }

    //  写入描述文件
    writeFileSync(
      join(outputFolder, "index.json"),
      JSON.stringify(splitZipsFileName)
    );

    //  删除源文件
    unlinkSync(join(folderPath, "fullCode.zip"));
  }

  deploy(props: { folder: string; configs: EVDConfigType }): Promise<void> {
    //  由于 cloudflare 限制了文件最大只能为 25m
    //  因此这里需要判断下，如果文件超过 25m 就进行分割
    this.splitFileIfNeed(props.folder);

    const cloudflareConfig = props.configs.cloudflare;
    if (!cloudflareConfig) throw new Error("cloudflare 配置为空");
    return new Promise<void>((res) => {
      const cmd = platform() === "win32" ? "wrangler.cmd" : "wrangler";
      // prettier-ignore
      const output = spawn(cmd, [
        "pages",
        "deploy",
        props.folder,
        "--project-name", cloudflareConfig.projectName,
      ],{
        stdio: ["pipe", "inherit", "inherit"],
        env:{
          ...process.env,
          "CLOUDFLARE_API_TOKEN":cloudflareConfig.token
        }
      });

      output.on("exit", function (code) {
        if (code === 0) {
          console.log(logSymbols.success, "部署完成！");
          res();
          return;
        }
        throw new Error("部署失败！");
      });
    });
  }

  validateConfig(configs: EVDConfigType): void | string {
    if (configs.cloudflare) {
      if (!configs.cloudflare.url || !/^https/.test(configs.cloudflare.url)) {
        return `configs.cloudflare.url 配置不正确`;
      }

      if (!configs.cloudflare.token) {
        return `configs.cloudflare.token 未配置`;
      }

      if (!configs.cloudflare.projectName) {
        return `configs.cloudflare.projectName 未配置`;
      }

      return;
    }

    return `configs.cloudflare 配置不存在`;
  }
}
