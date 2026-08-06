import { EVDConfigType } from "@/types/EVDConfigType";
import { ProviderInterface, ProviderName } from "./ProviderInterface";

export class SelfHosted implements ProviderInterface {
  private static _instance: SelfHosted;
  public static get instance(): SelfHosted {
    if (!this._instance) {
      this._instance = new SelfHosted();
    }

    return this._instance;
  }

  readonly name: ProviderName = "selfHosted";
  //  自建服务器没有 cloudflare 的 25mb 单文件限制
  readonly defaultZipSplitEnabled = false;

  getUrl(configs: EVDConfigType): string {
    return configs.selfHosted?.url as string;
  }

  deploy(): Promise<void> {
    throw new Error(
      "selfHosted 模式不支持 evd deploy，请执行 evd preDeploy 后自行上传 node_modules/.evd 目录"
    );
  }

  validateConfig(configs: EVDConfigType): void | string {
    if (configs.selfHosted) {
      //  自建服务器允许 http
      if (
        !configs.selfHosted.url ||
        !/^https?:\/\//.test(configs.selfHosted.url)
      ) {
        return `configs.selfHosted.url 配置不正确`;
      }

      return;
    }

    return `configs.selfHosted 配置不存在`;
  }
}
