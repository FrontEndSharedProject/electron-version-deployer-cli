import { program } from "commander";
import { getConfigs } from "../helpers/getConfigs";
import logSymbols from "log-symbols";
import { r } from "../utils";
import { getWhichProvider } from "../helpers/getWhichProvider";
import {
  createCheckPolicy,
  extractMinVersionCLIOptions,
  runDeployChecks,
  EVD_FOLDER,
} from "../helpers/deployChecks";
import { applyZipSplit, resolveZipSplitOptions } from "../helpers/zipSplit";

program
  .command("deploy")
  .description("执行部署")
  .option("--min-supported-version <version>", "显式指定最低支持版本")
  .option("--force-update", "将最低支持版本设为当前待部署版本")
  .option("--no-force-update", "本次部署不声明最低支持版本")
  .option("--split", "强制将全量更新包与增量更新包拆分为分片更新包")
  .option("--no-split", "不将全量更新包与增量更新包拆分为分片更新包")
  .action(async (options, command) => {
    try {
      const configs = await getConfigs();
      const provider = getWhichProvider(configs);

      await runDeployChecks(
        configs,
        provider,
        createCheckPolicy({ interactive: true }),
        extractMinVersionCLIOptions(
          options,
          command?.parent?.rawArgs ?? process.argv
        )
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
