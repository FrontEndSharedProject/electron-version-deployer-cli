import { EVDConfigType } from "@/types/EVDConfigType";
import { platform } from "node:os";
import { spawn } from "node:child_process";
import logSymbols from "log-symbols";
import { ProviderInterface } from "./ProviderInterface";

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

  deploy(props: { folder: string; configs: EVDConfigType }): Promise<void> {
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
    }

    return `configs.cloudflare 配置不存在`;
  }
}
