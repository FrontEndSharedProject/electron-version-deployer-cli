import { EVDConfigType } from "@/types/EVDConfigType";
import { ProviderInterface } from "../commands/hostingProvider/ProviderInterface";
import { Netlify } from "../commands/hostingProvider/Netlify";
import { Cloudflare } from "../commands/hostingProvider/Cloudflare";
import { SelfHosted } from "../commands/hostingProvider/SelfHosted";

export function getWhichProvider(configs: EVDConfigType): ProviderInterface {
  if (
    configs.netlify &&
    configs.netlify.url &&
    configs.netlify.siteID &&
    configs.netlify.token
  )
    return Netlify.instance;

  if (
    configs.cloudflare &&
    configs.cloudflare.projectName &&
    configs.cloudflare.token &&
    configs.cloudflare.url
  )
    return Cloudflare.instance;

  if (configs.selfHosted && configs.selfHosted.url) return SelfHosted.instance;

  throw new Error(
    "未提供/配置不正确 configs.netlify / configs.cloudflare / configs.selfHosted"
  );
}
