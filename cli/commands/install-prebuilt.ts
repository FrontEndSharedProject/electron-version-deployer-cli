import { program } from "commander";
import { getConfigs } from "../helpers/getConfigs";
import { EVDConfigType } from "@/types/EVDConfigType";
import { join } from "node:path";
import { readFileSync } from "node:fs";
//  @ts-ignore
import download from "download";
import logSymbols from "log-symbols";

program
  .command("install-prebuilt")
  .description("安装与构建包")
  .action(async (source, destination) => {
    const configs = await getConfigs();

    if (
      configs.prebuiltConfig &&
      Object.values(configs.prebuiltConfig).length > 0
    ) {
      await installPrebuilt(configs);
    }
  });

async function installPrebuilt(configs: EVDConfigType) {
  Object.entries(configs.prebuiltConfig).map(async ([moduleName, config]) => {
    const projectFolder = require.resolve(moduleName).split("node_modules")[0];
    const pkgFolder = join(projectFolder, "node_modules", moduleName);
    const pkgJSON = JSON.parse(
      readFileSync(join(pkgFolder, "package.json"), "utf-8")
    );
    const pkgVersion = pkgJSON.version;
    const hostUrl = pkgJSON.binary.host;
    const outputFolder = join(pkgFolder, ...config.outputPath);

    for (let j = 0; j < config.files.length; j++) {
      // 下载文件
      const downloadURL = `${hostUrl}v${pkgVersion}/${config.files[j]}`;
      const outputPath = join(outputFolder);
      await download(downloadURL, outputPath, {
        extract: true,
      });
      console.log(logSymbols.success, `下载: ${downloadURL} 成功！`);
    }
  });
}
