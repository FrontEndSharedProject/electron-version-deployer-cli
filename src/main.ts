import { BrowserWindow, ipcMain, app, shell, utilityProcess } from "electron";
import { format } from "node:url";
import { join, sep } from "node:path";
import {
  fetchRemoteChangelogJSON,
  fetchRemotePkgJSON,
} from "@/helpers/fetchRemotePkgJSON";
import { versionToNum } from "@/utils/versionToNum";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { compareObjectsIsEqual } from "@/utils/compareObjectsIsEqual";
import { CLI_NAME } from "@/const";
import installerCodeStr from "./installer?raw";
import templateHtmlStr from "../public/templates/newVersionDialog.html?raw";
import { platform } from "node:process";
import { forceDeleteSync } from "@/utils/utils";
import extract from "extract-zip";
import {
  netRequest,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "@/helpers/netRequest";
import { joinRemoteUrl } from "@/utils/joinRemoteUrl";
import {
  downloadFile,
  DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
} from "@/helpers/downloadFile";
import { toEVDError } from "@/helpers/toEVDError";
import {
  EVDError,
  EVDErrorCodeEnum,
  EVDErrorPhaseEnum,
  formatEVDErrorDetail,
} from "@/types/EVDErrorType";

export {
  EVDError,
  EVDErrorCodeEnum,
  EVDErrorPhaseEnum,
  EVD_ERROR_MESSAGES,
  isEVDError,
  formatEVDErrorDetail,
} from "@/types/EVDErrorType";

const id = `${Date.now()}-${Math.random()}`;

//  与 src/installer.js 中 postMessage 的字面量保持一致
const INSTALLER_DONE_MESSAGE = "exitManually";
const INSTALLER_FAILED_PREFIX = "installFailed:";

export enum EVDEventEnum {
  OPEN_LINK = "evd-open-link",
  UPDATE = "evd-update-now",
  SKIP = "evd-skip",
  GET_CHANGELOGS = "evd-get-change-logs",
  GET_LOGO = "evd-get-logo",
  GET_CHANGELOGS_LINK = "evd-get-changelogs-link",
  UPDATE_ERROR = "evd-update-error",
}

type EVDInitPropsType = {
  //  检测远程更新的地址
  netlifyUrl?: string;
  remoteUrl?: string;

  //  弹窗宽度
  windowWidth?: number;
  //  弹窗高度
  windowHeight?: number;
  //  logo 图标
  logo?: string;
  //  检测频率/s
  detectionFrequency?: number;
  //  是否在程序运行时进行检测
  detectAtStart?: boolean;
  //  检测更新的请求超时时间/ms，默认 10000
  requestTimeout?: number;
  //  下载更新包的停顿超时时间/ms，连续该时长没有新数据才算超时，默认 60000
  downloadStallTimeout?: number;
  //  自动检查更新（启动检测 + 定时轮询）失败时是否静默，不触发 onError，默认 false
  //  适用于更新地址需要 VPN 等网络前置条件的场景，避免用户一启动就被弹窗打扰
  silentAutoCheck?: boolean;
  //  自动检查更新失败时的回调，可只写日志不打扰用户
  //  未提供时：silentAutoCheck 为 true 则完全静默，否则回退到 onError
  onAutoCheckError?: (err: unknown) => void;
  //  当自动更新出现错误时的回掉，回调参数为 EVDError
  onError?: (err: unknown) => void;
  //  在开始安装前调用，可以在里面关闭一些数据库连接之类的
  onBeforeNewPkgInstall?: (next: () => any, version: string) => void;
};

let globalArgs: EVDInitPropsType | null = null;
let cacheChangelogs: any = null;
let cacheCurrentPkgJSON: any = null;

export function EVDInit(props: EVDInitPropsType) {
  //  废弃参数检测
  if (props.netlifyUrl) {
    props.remoteUrl = props.netlifyUrl;
    console.warn(
      "EVDInit 中的 netlifyUrl 参数已废弃，将会在下个主版本更新时删除，请使用 remoteUrl 代替"
    );
  }

  globalArgs = props;
  const { detectionFrequency, detectAtStart } = getConfigs();
  //  获取当前程序执行的 JSON 文件
  const appPath = app.getAppPath();
  cacheCurrentPkgJSON = JSON.parse(
    readFileSync(join(appPath, "package.json"), "utf-8")
  );

  setInterval(async () => {
    try {
      await EVDCheckUpdate();
    } catch (e) {
      handleAutoCheckError(e);
    }
  }, 1000 * detectionFrequency);

  if (!detectAtStart) return;
  setTimeout(async () => {
    try {
      await EVDCheckUpdate();
    } catch (e) {
      handleAutoCheckError(e);
    }
  }, 1000 * 2);
}

//  仅用于自动检查（启动检测 + 定时轮询）；手动调用 EVDCheckUpdate 的错误依旧原样 reject
function handleAutoCheckError(e: unknown) {
  const { onError, onAutoCheckError, silentAutoCheck } = getConfigs();
  const error = toEVDError(e, { phase: EVDErrorPhaseEnum.CHECK });

  if (onAutoCheckError) return onAutoCheckError(error);
  if (silentAutoCheck) return;
  onError(error);
}

export async function EVDCheckUpdate() {
  const { remoteUrl, requestTimeout } = getConfigs();
  const { version } = cacheCurrentPkgJSON;
  const remoteJSON = await fetchRemotePkgJSON(remoteUrl, requestTimeout);
  if (!remoteJSON) {
    throw new EVDError(EVDErrorCodeEnum.REMOTE_NOT_FOUND, {
      phase: EVDErrorPhaseEnum.CHECK,
      url: joinRemoteUrl(remoteUrl, "package.json"),
    });
  }

  const localVersion = versionToNum(version);
  const remoteVersion = versionToNum(remoteJSON.version);

  if (remoteVersion > localVersion) {
    await showNewVersionDialog();
    return true;
  } else {
    return false;
  }
}

async function showNewVersionDialog() {
  const { windowHeight, windowWidth, onError } = getConfigs();

  app.whenReady().then(async () => {
    try {
      let promptWindow = new BrowserWindow({
        frame: true,
        width: windowWidth,
        height: windowHeight,
        minWidth: windowWidth,
        minHeight: windowHeight,
        resizable: false,
        minimizable: false,
        fullscreenable: false,
        maximizable: false,
        skipTaskbar: true,
        //  windows 11 如果设置为 true 会导致点击后马上消失
        alwaysOnTop: platform !== "win32",
        useContentSize: false,
        title: "有可用的更新",
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
        },
        show: false,
      });

      promptWindow.setMenu(null);
      promptWindow.setMenuBarVisibility(false);

      //  解析模板路径：优先使用 node_modules 中的文件（向后兼容），不存在则使用内嵌模板
      const appPath = app.getAppPath();
      const nodeModulesTemplatePath = join(
        appPath,
        "node_modules",
        CLI_NAME,
        "dist",
        "templates",
        "newVersionDialog.html"
      );
      let templatePath: string;
      if (existsSync(nodeModulesTemplatePath)) {
        templatePath = nodeModulesTemplatePath;
      } else {
        templatePath = join(appPath, "_evdDialogTemplate.html");
        writeFileSync(templatePath, templateHtmlStr as string, "utf-8");
      }

      const promptUrl = format({
        protocol: "file",
        slashes: true,
        pathname: templatePath,
        hash: id,
      });

      promptWindow.loadURL(promptUrl);

      promptWindow.once("ready-to-show", () => {
        promptWindow.show();

        setTimeout(() => {
          const allWindows = BrowserWindow.getAllWindows();
          // 遍历每个窗口实例，并添加 'closed' 事件监听器
          allWindows.forEach((window) => {
            window.on("closed", () => {
              //  如果只剩下一个窗口，关闭自己
              if (BrowserWindow.getAllWindows().length == 1) {
                cleanup(promptWindow);
              }
            });
          });
        }, 1000);
      });

      promptWindow.once("close", () => {
        cleanup(promptWindow);
      });

      //  事件处理
      bindEvent(promptWindow, onError);
    } catch (e) {
      onError(e);
    }
  });
}

//  安装新版本
async function installNewVersion() {
  const { remoteUrl, requestTimeout } = getConfigs();

  const remoteJSON = await fetchRemotePkgJSON(remoteUrl, requestTimeout);
  const needInstallFullSize = compareObjectsIsEqual(
    remoteJSON.dependencies,
    cacheCurrentPkgJSON.dependencies
  );

  await installPkg(!needInstallFullSize ? "fullCode.zip" : "logicCode.zip");
}

async function installPkg(zipFile: string) {
  const { remoteUrl, requestTimeout, downloadStallTimeout } = getConfigs();
  const appPath = app.getAppPath();

  const unzipPath = join(appPath, "evdUnzip");
  const zipPath = unzipPath + ".zip";
  const installerFile = join(appPath, "_evdInstallerTmp.js");

  // 如果路径存在，清空它
  if (existsSync(unzipPath)) {
    rmSync(unzipPath, {
      force: true,
      maxRetries: 3,
      recursive: true,
    });
  }
  mkdirSync(unzipPath);

  //  如果是 cloudflare 会出现 fullCode.zip 被拆分在 fullCodeZipSplitZips 文件夹中的额问题
  //  原因是 cloudflare 只支持最大 25m 的文件上传
  //  需要判断下，如果远程是分段的 zip，就下载分段文件并且合并
  let fullCodeSplitIndexFile: false | string[] = false;
  try {
    fullCodeSplitIndexFile = await netRequest({
      url: joinRemoteUrl(
        remoteUrl,
        `fullCodeZipSplitZips/index.json?hash=${Math.random()}`
      ),
      responseType: "json",
      timeoutMs: requestTimeout,
      phase: EVDErrorPhaseEnum.DOWNLOAD,
    });
  } catch (e) {}

  //  如果满足远程分割的条件
  if (zipFile === "fullCode.zip" && Array.isArray(fullCodeSplitIndexFile)) {
    const tmpFilePaths = fullCodeSplitIndexFile.map((fileName) =>
      join(appPath, fileName)
    );

    try {
      for (const [index, fileName] of fullCodeSplitIndexFile.entries()) {
        await downloadFile({
          url: joinRemoteUrl(
            remoteUrl,
            `fullCodeZipSplitZips/${fileName}?hash=${Math.random()}`
          ),
          destPath: tmpFilePaths[index],
          stallTimeoutMs: downloadStallTimeout,
        });
      }

      //  分片全部下载完成后再合并，避免中途失败留下半个包
      await new Promise<void>((res, rej) => {
        const mergedStream = createWriteStream(zipPath);
        mergedStream.on("error", rej);
        for (const tmpFilePath of tmpFilePaths) {
          mergedStream.write(readFileSync(tmpFilePath));
        }
        mergedStream.end(() => res());
      });
    } finally {
      //  删除临时文件
      tmpFilePaths.filter(existsSync).forEach(forceDeleteSync);
    }
  } else {
    await downloadFile({
      url: joinRemoteUrl(remoteUrl, `${zipFile}?hash=${Math.random()}`),
      destPath: zipPath,
      stallTimeoutMs: downloadStallTimeout,
    });
  }

  //  解压
  try {
    await extract(zipPath, { dir: unzipPath });
  } catch (error) {
    throw new EVDError(EVDErrorCodeEnum.UNZIP_FAILED, {
      phase: EVDErrorPhaseEnum.INSTALL,
      cause: error,
    });
  }

  //  等待解压完成，解压需要一定时间
  await new Promise((res) => setTimeout(res, 1000));

  //  创建一个临时的 _evdInstallerTmp.js 文件用于 fork 安装
  //  避免出现 window 下资源占用问题
  writeFileSync(
    installerFile,
    Object.entries({
      __unzipPath__: unzipPath,
      __appPath__: appPath,
    }).reduce((prev, current) => {
      const [key, value] = current;
      return prev.replace(key, value.split(sep).join("/"));
    }, installerCodeStr as string)
  );

  await new Promise((res) => setTimeout(res, 1000));

  //  开始执行安装
  const child = utilityProcess.fork(join(appPath, "_evdInstallerTmp.js"));

  //  copy 需要事件，等待子进程执行完毕，或者超过 5 分钟
  await Promise.race([
    new Promise<void>((res, rej) => {
      let installError: EVDError | null = null;

      child.on("message", (msg) => {
        if (typeof msg === "string" && msg.startsWith(INSTALLER_FAILED_PREFIX)) {
          installError = new EVDError(EVDErrorCodeEnum.INSTALL_FAILED, {
            phase: EVDErrorPhaseEnum.INSTALL,
            message: msg.slice(INSTALLER_FAILED_PREFIX.length) || undefined,
          });
          rej(installError);
          return;
        }
        if (msg === INSTALLER_DONE_MESSAGE) res();
      });

      child.on("exit", () => (installError ? rej(installError) : res()));
    }),
    new Promise<void>((res) => setTimeout(res, 5 * 60 * 1000)),
  ]);
}

function bindEvent(promptWindow: BrowserWindow, onError) {
  const { logo, onBeforeNewPkgInstall, remoteUrl } = getConfigs();

  ipcMain.on(EVDEventEnum.OPEN_LINK, (_, link) => {
    shell.openExternal(link);
  });

  ipcMain.on(EVDEventEnum.SKIP, (_) => {
    promptWindow.close();
  });

  ipcMain.on(EVDEventEnum.UPDATE, (_) => {
    const handleUpdateFailed = (error: unknown) => {
      const evdError = toEVDError(error, { phase: EVDErrorPhaseEnum.DOWNLOAD });
      onError(evdError);
      //  通知弹窗展示错误，否则「软件更新中……」的遮罩会一直停在那里
      notifyUpdateError(promptWindow, evdError);
    };

    fetchRemotePkgJSON(remoteUrl, getConfigs().requestTimeout)
      .then((pkg) => {
        onBeforeNewPkgInstall(() => {
          installNewVersion()
            .then(() => {
              //  不知道什么情况会出现
              //  UnhandledRejection TypeError: Object has been destroyed
              setTimeout(() => promptWindow.close(), 1);
              setTimeout(() => app.relaunch(), 1);
              setTimeout(() => app.exit(), 1);
            })
            .catch(handleUpdateFailed);
        }, pkg.version);
      })
      .catch(handleUpdateFailed);
  });

  ipcMain.handle(EVDEventEnum.GET_LOGO, () => {
    return logo;
  });

  ipcMain.handle(EVDEventEnum.GET_CHANGELOGS, async () => {
    const { remoteUrl, requestTimeout } = getConfigs();

    return cacheChangelogs
      ? cacheChangelogs
      : await fetchRemoteChangelogJSON(remoteUrl, requestTimeout);
  });

  ipcMain.handle(EVDEventEnum.GET_CHANGELOGS_LINK, async () => {
    const { remoteUrl } = getConfigs();

    return joinRemoteUrl(remoteUrl, "changelogs.html");
  });
}

function notifyUpdateError(promptWindow: BrowserWindow, error: EVDError) {
  try {
    if (promptWindow.isDestroyed()) return;
    promptWindow.webContents.send(EVDEventEnum.UPDATE_ERROR, {
      code: error.code,
      phase: error.phase,
      message: error.message,
      detail: formatEVDErrorDetail(error, {
        当前版本: cacheCurrentPkgJSON?.version,
        更新地址: getConfigs().remoteUrl,
      }),
    });
  } catch (e) {}
}

function cleanup(promptWindow: BrowserWindow) {
  ipcMain.removeAllListeners(EVDEventEnum.OPEN_LINK);
  ipcMain.removeAllListeners(EVDEventEnum.SKIP);
  ipcMain.removeAllListeners(EVDEventEnum.UPDATE);
  ipcMain.removeHandler(EVDEventEnum.GET_CHANGELOGS);
  ipcMain.removeHandler(EVDEventEnum.GET_LOGO);
  ipcMain.removeHandler(EVDEventEnum.GET_CHANGELOGS_LINK);

  try {
    promptWindow?.focus();
    promptWindow?.destroy();
  } catch (e) {}
}

function getConfigs(): Required<EVDInitPropsType> {
  if (!globalArgs) {
    throw new EVDError(EVDErrorCodeEnum.NOT_INITIALIZED, {
      phase: EVDErrorPhaseEnum.CHECK,
    });
  }

  //  @ts-ignore
  return {
    ...{
      onError: () => {},
      silentAutoCheck: false,
      onAutoCheckError: undefined,
      onBeforeNewPkgInstall: (next, version: string) => {
        next();
      },
      windowHeight: 360,
      windowWidth: 400,
      logo: undefined,
      //  默认六小时检测一次
      detectionFrequency: 60 * 60 * 6,
      detectAtStart: true,
      requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
      downloadStallTimeout: DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
    },
    ...globalArgs,
    //  兼容 remoteUrl 带尾斜杠的写法，避免拼出 //package.json
    remoteUrl: (globalArgs.remoteUrl ?? "").replace(/\/+$/, ""),
  };
}
