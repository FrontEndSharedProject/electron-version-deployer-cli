import { EVDConfigType } from "@/types/EVDConfigType";

export interface ProviderInterface {
  //  判断 configs 是否正确
  validateConfig(configs: EVDConfigType): void | string;
  //  部署
  deploy(props: { folder: string; configs: EVDConfigType }): Promise<void>;
  getUrl(configs: EVDConfigType): string;
}
