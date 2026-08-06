// @ts-nocheck
import { defineEVDConfig } from "@/index";

export default defineEVDConfig({
  compileCommand: __compileCommand__,
  changelogsPath: __changelogsPath__,
  sources: {
    folder: __sources_folder__,
    nodeModules: __sources_nodeModules__,
    codes: __sources_codes__,
    packageJSON: __sources_packageJSON__,
  },
  netlify: {
    url: __netlify_url__,
    token: __netlify_token__,
    siteID: __netlify_siteID__,
  },
  cloudflare: {
    url: __cloudflare_url__,
    token: __cloudflare_token__,
    projectName: __cloudflare_projectName__,
  },
  //  自托管：由 CI 自行上传 node_modules/.evd，evd 只做检测
  //  selfHosted: {
  //    url: "https://cdn.example.com/app",
  //  },
  //  fullCode.zip 拆分设置，默认 cloudflare 拆分、其余不拆分
  //  zipSplit: {
  //    enabled: false,
  //    thresholdMB: 24,
  //    chunkSizeMB: 20,
  //  },
  prebuiltConfig: {},
});
