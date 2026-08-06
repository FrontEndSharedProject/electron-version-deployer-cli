import { program } from "commander";
import { getConfigs } from "../helpers/getConfigs";
import logSymbols from "log-symbols";
import { existsSync, readFileSync } from "node:fs";
import { formatBytes, r } from "../utils";
import { getWhichProvider } from "../helpers/getWhichProvider";
import { EVD_FOLDER } from "../helpers/deployChecks";
import { fetchRemoteJSON, probeRemoteFile } from "../helpers/remoteProbe";
import { joinRemoteUrl } from "@/utils/joinRemoteUrl";
import { SPLIT_FOLDER_NAME, FULL_CODE_ZIP_NAME } from "../helpers/zipSplit";

type CheckResult = {
  label: string;
  ok: boolean;
  detail: string;
};

program
  .command("verify")
  .description("上传完成后校验远程更新链接是否真的生效")
  .option("--retry <n>", "校验失败后的重试次数", "3")
  .option("--retry-delay <s>", "两次重试之间的间隔秒数", "5")
  .option("--timeout <ms>", "远程请求超时时间", "10000")
  .action(async (options) => {
    try {
      const configs = await getConfigs();
      const provider = getWhichProvider(configs);
      const url = provider.getUrl(configs);

      if (!existsSync(r(`${EVD_FOLDER}/package.json`))) {
        throw new Error(`未找到 .evd 文件夹，你需要先执行 evd prepare`);
      }

      const localPKG = JSON.parse(
        readFileSync(r(`${EVD_FOLDER}/package.json`), "utf-8")
      );
      const timeoutMs = Number(options.timeout);
      const retry = Math.max(1, Number(options.retry));
      const retryDelay = Number(options.retryDelay);

      console.log(
        logSymbols.info,
        `校验 ${url} (本地版本 ${localPKG.version})`
      );

      for (let attempt = 1; attempt <= retry; attempt++) {
        const results = await runChecks(url, localPKG, timeoutMs);
        const failed = results.filter((result) => !result.ok);

        if (!failed.length) {
          results.forEach(printResult);
          console.log(logSymbols.success, "远程校验通过");
          return;
        }

        if (attempt === retry) {
          results.forEach(printResult);
          throw new Error(`远程校验失败，共 ${failed.length} 项未通过`);
        }

        console.log(
          logSymbols.warning,
          `第 ${attempt}/${retry} 次校验有 ${failed.length} 项未通过，${retryDelay}s 后重试`
        );
        await new Promise((res) => setTimeout(res, retryDelay * 1000));
      }
    } catch (e: any) {
      console.log(logSymbols.error, e.toString());
      process.exitCode = 1;
    }
  });

async function runChecks(
  url: string,
  localPKG: any,
  timeoutMs: number
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const requestOptions = { timeoutMs, noCache: true };

  const remotePKG = await fetchRemoteJSON(
    joinRemoteUrl(url, "package.json"),
    requestOptions
  );
  if (!remotePKG.data) {
    results.push({
      label: "package.json",
      ok: false,
      detail: remotePKG.reason ?? "获取失败",
    });
  } else if (remotePKG.data.name !== localPKG.name) {
    results.push({
      label: "package.json",
      ok: false,
      detail: `name 不一致，远程 ${remotePKG.data.name}，本地 ${localPKG.name}`,
    });
  } else if (remotePKG.data.version !== localPKG.version) {
    results.push({
      label: "package.json",
      ok: false,
      detail: `version 不一致，远程 ${remotePKG.data.version}，本地 ${localPKG.version}`,
    });
  } else {
    results.push({
      label: "package.json",
      ok: true,
      detail: `${remotePKG.data.version} (与本地一致)`,
    });
  }

  const remoteChangelog = await fetchRemoteJSON(
    joinRemoteUrl(url, "changelog.json"),
    requestOptions
  );
  if (!remoteChangelog.data) {
    results.push({
      label: "changelog.json",
      ok: false,
      detail: remoteChangelog.reason ?? "获取失败",
    });
  } else if (remoteChangelog.data.version !== localPKG.version) {
    results.push({
      label: "changelog.json",
      ok: false,
      detail: `version 为 ${remoteChangelog.data.version}，本地为 ${localPKG.version}`,
    });
  } else {
    results.push({
      label: "changelog.json",
      ok: true,
      detail: `${remoteChangelog.data.version}`,
    });
  }

  results.push(await checkFile(url, "changelogs.html", requestOptions));
  results.push(await checkFile(url, "logicCode.zip", requestOptions));

  //  拆分包与整包只会存在一种
  const localSplitIndex = r(`${EVD_FOLDER}/${SPLIT_FOLDER_NAME}/index.json`);
  if (existsSync(localSplitIndex)) {
    results.push(...(await checkSplitZips(url, requestOptions)));
  } else {
    results.push(await checkFile(url, FULL_CODE_ZIP_NAME, requestOptions));
  }

  return results;
}

async function checkSplitZips(
  url: string,
  requestOptions: { timeoutMs: number; noCache: boolean }
): Promise<CheckResult[]> {
  const indexPath = `${SPLIT_FOLDER_NAME}/index.json`;
  const remoteIndex = await fetchRemoteJSON<string[]>(
    joinRemoteUrl(url, indexPath),
    requestOptions
  );

  if (!Array.isArray(remoteIndex.data)) {
    return [
      {
        label: indexPath,
        ok: false,
        detail: remoteIndex.reason ?? "内容不是分片列表",
      },
    ];
  }

  const results: CheckResult[] = [
    {
      label: indexPath,
      ok: true,
      detail: `${remoteIndex.data.length} 个分片`,
    },
  ];

  for (const fileName of remoteIndex.data) {
    results.push(
      await checkFile(url, `${SPLIT_FOLDER_NAME}/${fileName}`, requestOptions)
    );
  }

  return results;
}

async function checkFile(
  url: string,
  path: string,
  requestOptions: { timeoutMs: number; noCache: boolean }
): Promise<CheckResult> {
  const result = await probeRemoteFile(
    joinRemoteUrl(url, path),
    requestOptions
  );
  return {
    label: path,
    ok: result.ok,
    detail: result.ok
      ? result.size === undefined
        ? "可访问"
        : formatBytes(result.size)
      : `状态码 ${result.status}`,
  };
}

function printResult(result: CheckResult) {
  console.log(
    result.ok ? logSymbols.success : logSymbols.error,
    `${result.label}  ${result.detail}`
  );
}
