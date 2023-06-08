import { BrowserWindow, ipcMain, app, shell } from "electron";
import { format } from "node:url";
import { join, basename } from "node:path";
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
} from "node:fs";
import { compareObjectsIsEqual } from "@/utils/compareObjectsIsEqual";
import { get } from "node:https";
import extract from "extract-zip";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { CLI_NAME } from "@/const";

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
        minimizable: true,
        fullscreenable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
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
      });

      promptWindow.once("close", () => {
        cleanup(promptWindow);
      });

      //  事件处理
      bindEvent(promptWindow);
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

  //  覆盖安装
  copyFolderRecursiveSync(unzipPath, appPath);

  await new Promise((res) => setTimeout(res, 1000));
}

function bindEvent(promptWindow: BrowserWindow) {
  const { logo, onBeforeNewPkgInstall } = getConfigs();

  ipcMain.on(EVDEventEnum.OPEN_LINK, (_, link) => {
    shell.openExternal(link);
  });

  ipcMain.on(EVDEventEnum.SKIP, (_) => {
    promptWindow.close();
  });

  ipcMain.on(EVDEventEnum.UPDATE, (_) => {
    onBeforeNewPkgInstall(() => {
      installNewVersion().then(() => {
        promptWindow.close();
        app.relaunch();
        app.exit();
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

  promptWindow?.focus();

  if (promptWindow) {
    promptWindow.destroy();
  }
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

function copyFileSync(source, target) {
  let targetFile = target;

  if (existsSync(target)) {
    if (statSync(target).isDirectory()) {
      targetFile = join(target, basename(source));
    }
  }

  writeFileSync(targetFile, readFileSync(source));
}

// 复制文件夹及其内容的函数
function copyFolderRecursiveSync(source, target) {
  // 如果目标目录不存在，则创建目标目录
  if (!existsSync(target)) {
    mkdirSync(target);
  }

  // 获取源目录的文件列表
  const files = readdirSync(source);

  // 遍历文件列表，处理每个文件或子目录
  files.forEach((file) => {
    const sourcePath = join(source, file);
    const targetPath = join(target, file);

    // 如果当前文件是文件夹，则递归复制文件夹
    if (statSync(sourcePath).isDirectory()) {
      copyFolderRecursiveSync(sourcePath, targetPath);
    } else {
      // 否则，复制文件
      copyFileSync(sourcePath, targetPath);
    }
  });
}
