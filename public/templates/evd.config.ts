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
  prebuiltConfig: {},
});
