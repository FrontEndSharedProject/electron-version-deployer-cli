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
import { get } from "node:https";
import extract from "extract-zip";
import { CLI_NAME } from "@/const";
import installerCodeStr from "./installer?raw";
import { platform } from "node:process";

const id = `${Date.now()}-${Math.random()}`;

export enum EVDEventEnum {
  OPEN_LINK = "evd-open-link",
  UPDATE = "evd-update-now",
  SKIP = "evd-skip",
  GET_CHANGELOGS = "evd-get-change-logs",
  GET_LOGO = "evd-get-logo",
}

type EVDInitPropsType = {
  //  检测远程更新的地址
  netlifyUrl: string;

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
  //  当自动更新出现错误时的回掉
  onError?: (err: unknown) => void;
  //  在开始安装前调用，可以在里面关闭一些数据库连接之类的
  onBeforeNewPkgInstall?: (next: () => any) => void;
};

let globalArgs: EVDInitPropsType | null = null;
let cacheChangelogs: any = null;
let cacheCurrentPkgJSON: any = null;

export function EVDInit(props: EVDInitPropsType) {
  globalArgs = props;
  const { detectionFrequency, detectAtStart, onError } = getConfigs();

  setInterval(async () => {
    try {
      await EVDCheckUpdate();
    } catch (e) {
      onError(e);
    }
  }, 1000 * detectionFrequency);

  if (!detectAtStart) return;
  setTimeout(async () => {
    try {
      await EVDCheckUpdate();
    } catch (e) {
      onError(e);
    }
  }, 1000 * 2);

  //  获取当前程序执行的 JSON 文件
  const appPath = app.getAppPath();
  cacheCurrentPkgJSON = JSON.parse(
    readFileSync(join(appPath, "package.json"), "utf-8")
  );
}

export async function EVDCheckUpdate() {
  const { netlifyUrl } = getConfigs();
  const { version } = cacheCurrentPkgJSON;
  const remoteJSON = await fetchRemotePkgJSON(netlifyUrl);
  if (!remoteJSON) throw new Error(`${netlifyUrl}package.json 文件不存在`);

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

      const promptUrl = format({
        protocol: "file",
        slashes: true,
        pathname: join(
          app.getAppPath(),
          "node_modules",
          CLI_NAME,
          "dist",
          "templates",
          "newVersionDialog.html"
        ),
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
  const { netlifyUrl, onError } = getConfigs();

  const remoteJSON = await fetchRemotePkgJSON(netlifyUrl);
  const needInstallFullSize = compareObjectsIsEqual(
    remoteJSON.dependencies,
    cacheCurrentPkgJSON.dependencies
  );

  try {
    await installPkg(!needInstallFullSize ? "fullCode.zip" : "logicCode.zip");
  } catch (error: any) {
    onError(error);
  }
}

async function installPkg(zipFile: string) {
  const { netlifyUrl } = getConfigs();
  const appPath = app.getAppPath();

  const unzipPath = join(appPath, "evdUnzip");
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

  //  下载文件
  const tmpZipFilePath = createWriteStream(unzipPath + ".zip");
  await new Promise<void>((res, rej) =>
    get(`${netlifyUrl}/${zipFile}`, (response) => {
      response
        .pipe(tmpZipFilePath)
        .on("finish", () => {
          res();
        })
        .on("error", (err: any) => {
          rej(err);
        });
    }).on("error", (err) => {
      rej(err);
    })
  );

  //  解压
  await extract(unzipPath + ".zip", { dir: unzipPath });

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

  //  copy 需要事件，等待子进程执行完毕，或者超过 10 秒
  await Promise.race([
    new Promise((res) => {
      child.on("exit", () => res);
    }),
    new Promise((res) => {
      child.on("message", (msg) => {
        if (msg === "exitManually") {
          res(void 0);
        }
      });
    }),
    new Promise((res) => setTimeout(res, 5 * 60 * 1000)),
  ]);
}

function bindEvent(promptWindow: BrowserWindow, onError) {
  const { logo, onBeforeNewPkgInstall } = getConfigs();

  ipcMain.on(EVDEventEnum.OPEN_LINK, (_, link) => {
    shell.openExternal(link);
  });

  ipcMain.on(EVDEventEnum.SKIP, (_) => {
    promptWindow.close();
  });

  ipcMain.on(EVDEventEnum.UPDATE, (_) => {
    onBeforeNewPkgInstall(() => {
      installNewVersion()
        .then(() => {
          //  不知道什么情况会出现
          //  UnhandledRejection TypeError: Object has been destroyed
          setTimeout(() => promptWindow.close(), 1);
          setTimeout(() => app.relaunch(), 1);
          setTimeout(() => app.exit(), 1);
        })
        .catch((e) => {
          onError(e);
        });
    });
  });

  ipcMain.handle(EVDEventEnum.GET_LOGO, () => {
    return logo;
  });

  ipcMain.handle(EVDEventEnum.GET_CHANGELOGS, async () => {
    const { netlifyUrl } = getConfigs();

    return cacheChangelogs
      ? cacheChangelogs
      : await fetchRemoteChangelogJSON(netlifyUrl);
  });
}

function cleanup(promptWindow: BrowserWindow) {
  ipcMain.removeAllListeners(EVDEventEnum.OPEN_LINK);
  ipcMain.removeAllListeners(EVDEventEnum.SKIP);
  ipcMain.removeAllListeners(EVDEventEnum.UPDATE);
  ipcMain.removeHandler(EVDEventEnum.GET_CHANGELOGS);
  ipcMain.removeHandler(EVDEventEnum.GET_LOGO);

  try {
    promptWindow?.focus();
    promptWindow?.destroy();
  } catch (e) {}
}

function getConfigs(): Required<EVDInitPropsType> {
  if (!globalArgs) throw new Error("必须先执行 EVDInit 后才能继续运行！");
  //  @ts-ignore
  return {
    ...{
      onError: () => {},
      onBeforeNewPkgInstall: (next) => {
        next();
      },
      windowHeight: 360,
      windowWidth: 400,
      logo: undefined,
      //  默认六小时检测一次
      detectionFrequency: 60 * 60 * 6,
      detectAtStart: true,
    },
    ...globalArgs,
  };
}
