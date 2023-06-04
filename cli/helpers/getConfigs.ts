/**
 * 获取 evd.config.js 中的配置
 */
import { EVDConfigType } from "@/types/EVDConfigType";
import { r } from "../utils";
import { CLI_NAME, CONFIG_FILE_NAME } from "@/const";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { build } from "vite";
import vm from "node:vm";

export async function getConfigs(): Promise<EVDConfigType> {
  const configFilePath: string = r(CONFIG_FILE_NAME);
  if (!existsSync(configFilePath)) {
    throw new Error(`无法找到 ${configFilePath} 文件! `);
  }

  return await bundleConfigFileAndRead(r(CONFIG_FILE_NAME));
}

export async function bundleConfigFileAndRead(
  configFilePath: string
): Promise<EVDConfigType> {
  return new Promise((resolve) => {
    build({
      mode: "development",
      configFile: false,
      logLevel: "error",
      root: r(),
      resolve: {
        alias: {
          [CLI_NAME]: pathResolve(__dirname, "./index.es.js"),
        },
      },
      build: {
        ssr: true,
        write: false,
        commonjsOptions: {
          esmExternals: true,
        },
        emptyOutDir: false,
        sourcemap: false,
        cssCodeSplit: false,
        minify: false,
        lib: {
          entry: configFilePath,
          name: "_",
          formats: ["cjs"],
        },
      },
    }).then((data) => {
      const script = new vm.Script(data[0].output[0].code);
      const ctx = {
        require: require,
        module: module,
      };
      script.runInNewContext(ctx);
      resolve(ctx.module.exports);
    });
  });
}
