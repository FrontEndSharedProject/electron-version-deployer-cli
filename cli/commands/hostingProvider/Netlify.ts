import { EVDConfigType } from "@/types/EVDConfigType";
import { platform } from "node:os";
import { spawn } from "node:child_process";
import logSymbols from "log-symbols";
import { ProviderInterface } from "./ProviderInterface";

export class Netlify implements ProviderInterface {
  private static _instance: Netlify;
  public static get instance(): Netlify {
    if (!this._instance) {
      this._instance = new Netlify();
    }

    return this._instance;
  }

  getUrl(configs: EVDConfigType): string {
    return configs.netlify?.url as string;
  }

  deploy(props: { folder: string; configs: EVDConfigType }): Promise<void> {
    const netlifyConfig = props.configs.netlify;
    if (!netlifyConfig) throw new Error("netlify 配置为空");
    return new Promise<void>((res) => {
      const cmd = platform() === "win32" ? "netlify.cmd" : "netlify";
      // prettier-ignore
      const output = spawn(cmd, [
      "deploy",
      "--dir", props.folder,
      "--site", netlifyConfig.siteID,
      "--auth", netlifyConfig.token,
      "--prod",
      "--debug",
    ],{
      stdio: ["pipe", "inherit", "inherit"]
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
    if (configs.netlify) {
      if (!configs.netlify.url || !/^https/.test(configs.netlify.url)) {
        return `configs.netlify.url 配置不正确`;
      }

      if (!configs.netlify.token) {
        return `configs.netlify.token 未配置`;
      }

      if (!configs.netlify.siteID) {
        return `configs.netlify.siteID 未配置`;
      }
      return;
    }

    return `configs.netlify 配置不存在`;
  }
}
