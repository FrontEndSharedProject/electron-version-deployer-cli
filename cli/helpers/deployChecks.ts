import { EVDConfigType } from "@/types/EVDConfigType";
import { confirm } from "@inquirer/prompts";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  cpSync,
} from "node:fs";
import { basename, join } from "node:path";
import logSymbols from "log-symbols";
import { r } from "../utils";
import { STRICT_VERSION_RE, versionToNum } from "@/utils/versionToNum";
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
  allowMinVersionDowngrade: boolean;
  timeoutMs: number;
  confirm?: (opts: { message: string }) => Promise<boolean>;
};

export const EVD_FOLDER = "node_modules/.evd";

export type MinVersionCLIOptions = {
  minSupportedVersion?: string;
  forceUpdate?: boolean;
  noForceUpdate?: boolean;
};

export type ResolvedMinSupportedVersion = {
  minSupportedVersion?: string;
  source: "CLI" | "配置" | "未声明";
};

export function extractMinVersionCLIOptions(
  options: Record<string, any>,
  rawArgs?: string[]
): MinVersionCLIOptions {
  if (!rawArgs) {
    return {
      minSupportedVersion: options.minSupportedVersion,
      forceUpdate: options.forceUpdate,
      noForceUpdate: options.forceUpdate === false,
    };
  }
  const hasRawForceUpdate = rawArgs.includes("--force-update");
  const hasRawNoForceUpdate = rawArgs.includes("--no-force-update");
  const hasRawMinVersion = rawArgs.some(
    (arg) =>
      arg === "--min-supported-version" ||
      arg.startsWith("--min-supported-version=")
  );
  return {
    minSupportedVersion: hasRawMinVersion
      ? options.minSupportedVersion
      : undefined,
    forceUpdate: hasRawForceUpdate
      ? true
      : hasRawNoForceUpdate
      ? false
      : undefined,
    noForceUpdate: hasRawNoForceUpdate,
  };
}

export function validateMinSupportedVersionValue(
  minSupportedVersion: string,
  localVersion: string
) {
  if (!STRICT_VERSION_RE.test(minSupportedVersion)) {
    throw new Error(
      `最低支持版本格式非法: "${minSupportedVersion}"，必须为 x.y.z 三段数字格式`
    );
  }
  if (versionToNum(minSupportedVersion) > versionToNum(localVersion)) {
    throw new Error(
      `最低支持版本 ${minSupportedVersion} 不能高于当前待部署版本 ${localVersion}`
    );
  }
}

export function resolveMinSupportedVersion(
  configs: Pick<EVDConfigType, "minSupportedVersion">,
  localVersion: string,
  cliOptions: MinVersionCLIOptions = {}
): ResolvedMinSupportedVersion {
  const hasMinVersion = cliOptions.minSupportedVersion !== undefined;
  const hasForceUpdate = cliOptions.forceUpdate === true;
  const hasNoForceUpdate =
    cliOptions.noForceUpdate === true || cliOptions.forceUpdate === false;

  if ([hasMinVersion, hasForceUpdate, hasNoForceUpdate].filter(Boolean).length > 1) {
    throw new Error(
      "--min-supported-version、--force-update 与 --no-force-update 互斥，不能同时使用"
    );
  }

  if (hasNoForceUpdate) {
    return { minSupportedVersion: undefined, source: "CLI" };
  }

  let minSupportedVersion: string | undefined;
  let source: "CLI" | "配置" | "未声明" = "未声明";

  if (hasForceUpdate) {
    minSupportedVersion = localVersion;
    source = "CLI";
  } else if (hasMinVersion) {
    minSupportedVersion = cliOptions.minSupportedVersion;
    source = "CLI";
  } else if (configs.minSupportedVersion !== undefined) {
    minSupportedVersion = configs.minSupportedVersion;
    source = "配置";
  }

  if (minSupportedVersion !== undefined) {
    validateMinSupportedVersionValue(minSupportedVersion, localVersion);
  }

  return { minSupportedVersion, source };
}

export function applyMinSupportedVersion(
  evdFolderPath: string,
  minSupportedVersion?: string
) {
  const pkgPath = join(evdFolderPath, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (minSupportedVersion === undefined) {
    delete pkg.minSupportedVersion;
  } else {
    pkg.minSupportedVersion = minSupportedVersion;
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");
}

export function createCheckPolicy(partial: Partial<CheckPolicy>): CheckPolicy {
  return {
    interactive: false,
    allowFirstDeploy: false,
    allowNameMismatch: false,
    allowSameVersion: false,
    allowDowngrade: false,
    allowMinVersionDowngrade: false,
    timeoutMs: 10000,
    ...partial,
  };
}

export async function runDeployChecks(
  configs: EVDConfigType,
  provider: ProviderInterface,
  policy: CheckPolicy,
  cliMinVersionOptions: MinVersionCLIOptions = {}
): Promise<ResolvedMinSupportedVersion> {
  checkEVDFolderExist();
  validateConfigs(configs, provider);

  const compiledPackageJSON = JSON.parse(
    readFileSync(r(`${EVD_FOLDER}/package.json`), "utf-8")
  );
  const resolvedMinVersion = resolveMinSupportedVersion(
    configs,
    compiledPackageJSON.version,
    cliMinVersionOptions
  );

  console.log(
    logSymbols.info,
    `最低支持版本: ${resolvedMinVersion.minSupportedVersion ?? "未声明"} (来源: ${resolvedMinVersion.source})`
  );

  const remotePKG = await checkRemotePackageJSON(configs, provider, policy);
  if (remotePKG) {
    await validateRemotePackageJSON(
      remotePKG,
      compiledPackageJSON,
      policy,
      resolvedMinVersion
    );
  }

  if (policy.interactive && resolvedMinVersion.minSupportedVersion) {
    const confirmFn = policy.confirm ?? confirm;
    const confirmed = await confirmFn({
      message: `低于 ${resolvedMinVersion.minSupportedVersion} 的客户端将被强制更新，确认继续吗？`,
    });
    if (!confirmed) throw new Error("部署已停止！");
  }

  await deployExtraFolders(configs);
  applyMinSupportedVersion(r(EVD_FOLDER), resolvedMinVersion.minSupportedVersion);

  return resolvedMinVersion;
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
    const confirmFn = policy.confirm ?? confirm;
    const answer = await confirmFn({ message: question });
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
async function validateRemotePackageJSON(
  remotePKG: any,
  compiledPackageJSON: any,
  policy: CheckPolicy,
  resolvedMinVersion: ResolvedMinSupportedVersion
) {
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
      const confirmFn = policy.confirm ?? confirm;
      const answerDoubleCheck = await confirmFn({
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

  const remoteMin = remotePKG.minSupportedVersion;
  const localMin = resolvedMinVersion.minSupportedVersion;
  const isMinVersionDowngrade =
    typeof remoteMin === "string" &&
    STRICT_VERSION_RE.test(remoteMin) &&
    (localMin === undefined || versionToNum(remoteMin) > versionToNum(localMin));

  if (isMinVersionDowngrade && resolvedMinVersion.source !== "CLI") {
    const localMinLabel = localMin ?? "未声明";
    await gate({
      statement: `远程最低支持版本 ${remoteMin} 高于本次生效值 ${localMinLabel}`,
      question: `检测到远程最低支持版本 ${remoteMin} 高于本次生效值 ${localMinLabel}，确定要降低或取消最低支持版本吗?`,
      allowed: policy.allowMinVersionDowngrade,
      flag: "--allow-min-version-downgrade",
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
