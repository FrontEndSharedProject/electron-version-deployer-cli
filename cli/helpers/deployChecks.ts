import { EVDConfigType } from "@/types/EVDConfigType";
import { confirm } from "@inquirer/prompts";
import { existsSync, readFileSync, rmSync, statSync, cpSync } from "node:fs";
import { basename } from "node:path";
import logSymbols from "log-symbols";
import { r } from "../utils";
import { versionToNum } from "@/utils/versionToNum";
import { ProviderInterface } from "../commands/hostingProvider/ProviderInterface";
import { fetchRemoteJSON } from "./remoteProbe";
import { joinRemoteUrl } from "@/utils/joinRemoteUrl";

export type CheckPolicy = {
  //  false 时不弹任何交互，命中风险项按 allowXxx 决定放行还是报错
  interactive: boolean;
  allowFirstDeploy: boolean;
  allowNameMismatch: boolean;
  allowSameVersion: boolean;
  allowDowngrade: boolean;
  timeoutMs: number;
};

export const EVD_FOLDER = "node_modules/.evd";

export function createCheckPolicy(partial: Partial<CheckPolicy>): CheckPolicy {
  return {
    interactive: false,
    allowFirstDeploy: false,
    allowNameMismatch: false,
    allowSameVersion: false,
    allowDowngrade: false,
    timeoutMs: 10000,
    ...partial,
  };
}

export async function runDeployChecks(
  configs: EVDConfigType,
  provider: ProviderInterface,
  policy: CheckPolicy
) {
  checkEVDFolderExist();
  validateConfigs(configs, provider);
  const remotePKG = await checkRemotePackageJSON(configs, provider, policy);
  if (remotePKG) await validateRemotePackageJSON(remotePKG, policy);
  await deployExtraFolders(configs);
}

/**
 * 交互模式下弹确认框，非交互模式下按 allowed 决定 warn 还是抛错
 */
async function gate(props: {
  //  非交互模式下打印的陈述句
  statement: string;
  //  交互模式下的确认文案
  question: string;
  allowed: boolean;
  flag: string;
  policy: CheckPolicy;
}) {
  const { statement, question, allowed, flag, policy } = props;

  if (policy.interactive) {
    const answer = await confirm({ message: question });
    if (!answer) throw new Error("部署已停止！");
    return;
  }

  if (allowed) {
    console.log(logSymbols.warning, `${statement}（已通过 ${flag} 放行）`);
    return;
  }

  throw new Error(`${statement}\n  如确认无误，请加上 ${flag} 参数放行`);
}

/**
 * 拉取远程 package.json，顺带检查远程是否已部署过版本
 * 返回 null 表示远程尚未部署过（且已被放行）
 */
async function checkRemotePackageJSON(
  configs: EVDConfigType,
  provider: ProviderInterface,
  policy: CheckPolicy
) {
  const url = provider.getUrl(configs);
  const { data, reason } = await fetchRemoteJSON(
    joinRemoteUrl(url, "package.json"),
    {
      timeoutMs: policy.timeoutMs,
      noCache: true,
    }
  );

  if (!data) {
    await gate({
      statement: `${url} 上还未部署过任何版本（${reason}）`,
      question: `似乎 ${url} 还未部署过任何版本，确认继续吗？`,
      allowed: policy.allowFirstDeploy,
      flag: "--allow-first-deploy",
      policy,
    });
    return null;
  }

  console.log(
    logSymbols.info,
    `远程当前版本 ${data.version} (${joinRemoteUrl(url, "package.json")})`
  );
  return data;
}

/**
 * 检查远程的 package.json 是否符合标准
 */
async function validateRemotePackageJSON(remotePKG: any, policy: CheckPolicy) {
  const compiledPackageJSON = JSON.parse(
    readFileSync(r(`${EVD_FOLDER}/package.json`), "utf-8")
  );
  const compiledName = compiledPackageJSON.name;
  const remoteName = remotePKG.name;

  //  名称必须相等
  if (compiledName !== remoteName) {
    const statement = `项目名称不一致，编译后的项目名称: ${compiledName}, 远程 package.json 中的项目名称 ${remoteName}`;
    await gate({
      statement,
      question: `检测到项目名称不一致，确定继续吗 编译后的项目名称: ${compiledName}, 远程 package.json 中的项目名称 ${remoteName}`,
      allowed: policy.allowNameMismatch,
      flag: "--allow-name-mismatch",
      policy,
    });

    if (policy.interactive) {
      const answerDoubleCheck = await confirm({
        message: `确定继续执行吗？这将会覆盖远程的版本！`,
      });
      if (!answerDoubleCheck) throw new Error(`部署已停止`);
    }
  }

  //  判断远程版本号是否合理，比如是否大于或者等于当前版本
  const localVersion = versionToNum(compiledPackageJSON.version);
  const remoteVersion = versionToNum(remotePKG.version);

  if (localVersion == remoteVersion) {
    await gate({
      statement: `远程部署版本和当前版本一致 ${remotePKG.version}`,
      question: `检测到远程部署版本和当前版本一致 ${remotePKG.version}，确定要覆盖部署吗?`,
      allowed: policy.allowSameVersion,
      flag: "--allow-same-version",
      policy,
    });
  } else if (remoteVersion > localVersion) {
    await gate({
      statement: `远程部署版本 ${remotePKG.version} 大于当前版本 ${compiledPackageJSON.version}`,
      question: `检测到远程部署版本为 ${remotePKG.version} 大于当前版本 ${compiledPackageJSON.version}，确定要覆盖部署吗?`,
      allowed: policy.allowDowngrade,
      flag: "--allow-downgrade",
      policy,
    });
  }
}

/**
 * 判断配置是否正确
 */
function validateConfigs(configs: EVDConfigType, provider: ProviderInterface) {
  const error = provider.validateConfig(configs);
  if (error) throw new Error(error);
}

//  判断 .evd 文件夹是否存在
function checkEVDFolderExist() {
  if (!existsSync(r(EVD_FOLDER))) {
    throw new Error(`未找到 .evd 文件夹，你需要先执行 evd prepare`);
  }
}

export async function deployExtraFolders(configs: EVDConfigType) {
  const extraFolders = configs.extraFolders;
  if (!extraFolders) return;

  let folders: string[] = [];
  if (typeof extraFolders === "function") {
    folders = await extraFolders();
  } else {
    folders = extraFolders;
  }

  for (const folder of folders) {
    //  判断文件是否存在
    if (!existsSync(r(folder))) {
      throw new Error(`未找到文件夹 ${folder}`);
    }

    // 判断文件是否为文件夹
    const stat = statSync(r(folder));
    if (!stat.isDirectory()) {
      throw new Error(`${folder} 不是一个文件夹`);
    }

    // 如果 folder 存在先删除
    const destFolder = r(`${EVD_FOLDER}/${basename(folder)}`);
    if (existsSync(destFolder)) {
      rmSync(destFolder, { recursive: true });
    }

    // 复制文件
    cpSync(r(folder), destFolder, {
      recursive: true,
    });

    console.log(
      logSymbols.success,
      `已复制 ${folder} → .evd/${basename(folder)}`
    );
  }
}
