import { program } from "commander";
import { getConfigs } from "../helpers/getConfigs";
import logSymbols from "log-symbols";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatBytes, r } from "../utils";
import { getWhichProvider } from "../helpers/getWhichProvider";
import {
  createCheckPolicy,
  runDeployChecks,
  EVD_FOLDER,
} from "../helpers/deployChecks";
import { applyZipSplit, resolveZipSplitOptions } from "../helpers/zipSplit";

program
  .command("preDeploy")
  .alias("pre-deploy")
  .description(
    "非交互的部署前检测，通过后 node_modules/.evd 即可直接上传（用于 CI 自行上传的场景）"
  )
  .option("--allow-first-deploy", "允许远程尚未部署过任何版本")
  .option("--allow-name-mismatch", "允许本地与远程 package.json name 不一致")
  .option("--allow-same-version", "允许远程版本与本地一致")
  .option("--allow-downgrade", "允许远程版本高于本地")
  .option("--force", "等价于开启上面全部 --allow-* 参数")
  .option("--split", "强制拆分 fullCode.zip")
  .option("--no-split", "不拆分 fullCode.zip")
  .option("--timeout <ms>", "远程请求超时时间", "10000")
  .action(async (options) => {
    try {
      const configs = await getConfigs();
      const provider = getWhichProvider(configs);
      console.log(logSymbols.info, `使用 provider: ${provider.name}`);

      const force = !!options.force;
      await runDeployChecks(
        configs,
        provider,
        createCheckPolicy({
          interactive: false,
          allowFirstDeploy: force || !!options.allowFirstDeploy,
          allowNameMismatch: force || !!options.allowNameMismatch,
          allowSameVersion: force || !!options.allowSameVersion,
          allowDowngrade: force || !!options.allowDowngrade,
          timeoutMs: Number(options.timeout),
        })
      );

      const zipSplitOptions = resolveZipSplitOptions(
        configs,
        provider,
        options.split
      );
      applyZipSplit(r(EVD_FOLDER), zipSplitOptions);

      printUploadManifest();
      console.log(
        logSymbols.success,
        `检测通过，可将 ${r(EVD_FOLDER)} 上传至 ${provider.getUrl(configs)}`
      );
    } catch (e: any) {
      console.log(logSymbols.error, e.toString());
      process.exitCode = 1;
    }
  });

function printUploadManifest() {
  const folder = r(EVD_FOLDER);
  console.log(logSymbols.info, `待上传内容 ${folder}`);

  for (const entry of readdirSync(folder)) {
    const entryPath = join(folder, entry);
    const stat = statSync(entryPath);
    const size = stat.isDirectory() ? folderSize(entryPath) : stat.size;
    console.log(
      `   ${stat.isDirectory() ? `${entry}/` : entry}  ${formatBytes(size)}`
    );
  }
}

function folderSize(folderPath: string): number {
  return readdirSync(folderPath).reduce((total, entry) => {
    const entryPath = join(folderPath, entry);
    const stat = statSync(entryPath);
    return total + (stat.isDirectory() ? folderSize(entryPath) : stat.size);
  }, 0);
}
