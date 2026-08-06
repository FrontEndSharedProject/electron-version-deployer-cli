import { EVDConfigType } from "@/types/EVDConfigType";

export type ProviderName = "netlify" | "cloudflare" | "selfHosted";

export interface ProviderInterface {
  //  provider 标识，用于日志与默认值推断
  readonly name: ProviderName;
  //  该 provider 下 zipSplit 的默认开关
  readonly defaultZipSplitEnabled: boolean;
  //  判断 configs 是否正确
  validateConfig(configs: EVDConfigType): void | string;
  //  部署
  deploy(props: { folder: string; configs: EVDConfigType }): Promise<void>;
  getUrl(configs: EVDConfigType): string;
}
