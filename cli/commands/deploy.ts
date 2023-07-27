import { program } from "commander";
import { getConfigs } from "../helpers/getConfigs";
import logSymbols from "log-symbols";
import { EVDConfigType } from "@/types/EVDConfigType";
import { confirm } from "@inquirer/prompts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { r } from "../utils";
import { fetchRemotePkgJSON } from "@/helpers/fetchRemotePkgJSON";
import { versionToNum } from "@/utils/versionToNum";
import { Netlify } from "./hostingProvider/Netlify";
import { Cloudflare } from "./hostingProvider/Cloudflare";

program
  .command("deploy")
  .description("执行部署")
  .action(async (source, destination) => {
    const configs = await getConfigs();

    try {
      await checkEVDFolderExist();
      await validateConfigs(configs);
      await checkIsFirstTimeDeploy(configs);
      await validateRemotePackageJSON(configs);
      await deploy(configs);
    } catch (e: any) {
      console.log(logSymbols.error, e.toString());
    }
  });

async function deploy(configs: EVDConfigType) {
  console.log(logSymbols.info, "开始部署", r());

  await getWhichProvider(configs).deploy({
    folder: r("node_modules/.evd"),
    configs: configs,
  });
}

/**
 * 检查远程的 package.json 是否符合标准
 * @param configs
 */
async function validateRemotePackageJSON(configs: EVDConfigType) {
  const url = getWhichProvider(configs).getUrl(configs);
  const compiledPackageJSON = JSON.parse(
    readFileSync(r("node_modules/.evd/package.json"), "utf-8")
  );
  const compiledName = compiledPackageJSON.name;
  const remotePKG = await fetchRemotePkgJSON(url);
  if (!remotePKG) return;

  const remoteName = remotePKG.name;

  //  名称必须相等
  if (compiledName !== remoteName) {
    const answer = await confirm({
      message: `检测到项目名称不一致，确定继续吗 编译后的项目名称: ${compiledName}, 远程 package.json 中的项目名称 ${remoteName}`,
    });

    if (!answer) throw new Error(`部署已停止`);
    const answerDoubleCheck = await confirm({
      message: `确定继续执行吗？这将会覆盖远程的版本！`,
    });

    if (!answerDoubleCheck) throw new Error(`部署已停止`);
  }

  //  判断远程版本号是否合理，比如是否大于或者等于当前版本
  const localVersion = versionToNum(compiledPackageJSON.version);
  const remoteVersion = versionToNum(remotePKG.version);

  if (localVersion == remoteVersion) {
    const answer = await confirm({
      message: `检测到远程部署版本和当前版本一致 ${remotePKG.version}，确定要覆盖部署吗?`,
    });
    if (!answer) throw new Error(`部署已停止`);
  } else if (remoteVersion > localVersion) {
    const answer = await confirm({
      message: `检测到远程部署版本为 ${remotePKG.version} 大于当前版本 ${compiledPackageJSON.version}，确定要覆盖部署吗?`,
    });
    if (!answer) throw new Error(`部署已停止`);
  }
}

async function checkIsFirstTimeDeploy(configs: EVDConfigType) {
  const url = getWhichProvider(configs).getUrl(configs);

  const remotePKG = await fetchRemotePkgJSON(url);
  if (!remotePKG) {
    const answer = await confirm({
      message: `似乎 ${url} 还未部署过任何版本，确认继续吗？`,
    });
    if (!answer) {
      throw new Error("部署已停止！");
    }
  }
}

/**
 * 判断配置是否正确
 * @param configs
 */
async function validateConfigs(configs: EVDConfigType) {
  const error = getWhichProvider(configs).validateConfig(configs);
  if (error) throw new Error(error);
}

export function getWhichProvider(configs: EVDConfigType) {
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

  throw new Error("未提供/配置不正确 configs.netlify / configs.cloudflare");
}

//  判断 .evd 文件夹是否存在
async function checkEVDFolderExist() {
  if (!existsSync(r("node_modules/.evd"))) {
    throw new Error(`未找到 .evd 文件夹，你需要先执行 evd prepare`);
  }
}
