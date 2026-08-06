import { program } from "commander";
import { getConfigs } from "../helpers/getConfigs";
import logSymbols from "log-symbols";
import { r } from "../utils";
import { getWhichProvider } from "../helpers/getWhichProvider";
import {
  createCheckPolicy,
  runDeployChecks,
  EVD_FOLDER,
} from "../helpers/deployChecks";
import { applyZipSplit, resolveZipSplitOptions } from "../helpers/zipSplit";

program
  .command("deploy")
  .description("执行部署")
  .option("--split", "强制拆分 fullCode.zip")
  .option("--no-split", "不拆分 fullCode.zip")
  .action(async (options) => {
    try {
      const configs = await getConfigs();
      const provider = getWhichProvider(configs);

      await runDeployChecks(
        configs,
        provider,
        createCheckPolicy({ interactive: true })
      );

      applyZipSplit(
        r(EVD_FOLDER),
        resolveZipSplitOptions(configs, provider, options.split)
      );

      console.log(logSymbols.info, "开始部署", r());
      await provider.deploy({
        folder: r(EVD_FOLDER),
        configs: configs,
      });
    } catch (e: any) {
      console.log(logSymbols.error, e.toString());
      process.exitCode = 1;
    }
  });
