import { BrowserWindow, ipcMain, app, shell, utilityProcess } from "electron";
import { format } from "node:url";
import { join, sep } from "node:path";
import {
  fetchRemoteChangelogJSON,
  fetchRemotePkgJSON,
} from "@/helpers/fetchRemotePkgJSON";
import { STRICT_VERSION_RE, versionToNum } from "@/utils/versionToNum";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { compareObjectsIsEqual } from "@/utils/compareObjectsIsEqual";
import {
  CLI_NAME,
  FULL_CODE_ZIP_NAME,
  LOGIC_CODE_ZIP_NAME,
  LOGIC_SPLIT_FOLDER_NAME,
  SPLIT_FOLDER_NAME,
} from "@/const";
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
import {
  describeRuntimeEnvironment,
  detectUpdateEnvironment,
  toEVDError,
} from "@/helpers/toEVDError";
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
const STALL_THRESHOLD_MS = 10000;
const PROGRESS_IPC_THROTTLE_MS = 80;
const OPTIONAL_UPDATE_TITLE = "有可用的更新";
const FORCE_UPDATE_TITLE = "版本过低，必须安装新版本";
const EVD_TEMPLATE_VERSION = 1;

export enum EVDEventEnum {
  OPEN_LINK = "evd-open-link",
  UPDATE = "evd-update-now",
  SKIP = "evd-skip",
  GET_CHANGELOGS = "evd-get-change-logs",
  GET_LOGO = "evd-get-logo",
  GET_CHANGELOGS_LINK = "evd-get-changelogs-link",
  UPDATE_ERROR = "evd-update-error",
  UPDATE_PROGRESS = "evd-update-progress",
  GET_FORCE_UPDATE = "evd-get-force-update",
  FORCE_UPDATE_CHANGE = "evd-force-update-change",
}

export type EVDUpdateStageType =
  | "precheck"
  | "download"
  | "unzip"
  | "install"
  | "relaunch";

export type EVDUpdateProgressPayload = {
  stage: EVDUpdateStageType;
  stageTitle: string;
  percent: number;
  completed?: number;
  total?: number;
  progressText: string;
  currentItem: string;
  elapsedSeconds: number;
  stalled: boolean;
  stalledSeconds: number;
  stalledReason?: string;
  diagnosticText: string;
  stepValues: Record<EVDUpdateStageType, string>;
};

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
  //  强制更新模式下用户选择退出软件前调用，可在里面保存数据，必须调用 next() 才会退出
  onBeforeForceExit?: (next: () => void) => void;
};

let globalArgs: EVDInitPropsType | null = null;
let cacheChangelogs: any = null;
let cacheCurrentPkgJSON: any = null;
let activePromptWindow: BrowserWindow | null = null;
let activeTracker: UpdateProgressTracker | null = null;
let isUpdating = false;
let isForceUpdate = false;
let isRelaunching = false;
let isForceExitPending = false;
let autoCheckIntervalId: NodeJS.Timeout | null = null;
let autoCheckStartupTimeoutId: NodeJS.Timeout | null = null;

function shouldForceUpdate(localVersionStr: string, remoteJSON: any): boolean {
  const minSupportedVersion = remoteJSON?.minSupportedVersion;
  if (
    typeof minSupportedVersion !== "string" ||
    !STRICT_VERSION_RE.test(minSupportedVersion)
  ) {
    return false;
  }
  return versionToNum(localVersionStr) < versionToNum(minSupportedVersion);
}

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

  if (autoCheckIntervalId) {
    clearInterval(autoCheckIntervalId);
    autoCheckIntervalId = null;
  }
  if (autoCheckStartupTimeoutId) {
    clearTimeout(autoCheckStartupTimeoutId);
    autoCheckStartupTimeoutId = null;
  }

  autoCheckIntervalId = setInterval(async () => {
    try {
      await EVDCheckUpdate();
    } catch (e) {
      handleAutoCheckError(e);
    }
  }, 1000 * detectionFrequency);

  if (!detectAtStart) return;
  autoCheckStartupTimeoutId = setTimeout(async () => {
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
  if (typeof remoteJSON.version !== "string" || !remoteJSON.version.trim()) {
    throw new EVDError(EVDErrorCodeEnum.REMOTE_INVALID_JSON, {
      phase: EVDErrorPhaseEnum.CHECK,
      url: joinRemoteUrl(remoteUrl, "package.json"),
      cause: "package.json 缺少 version 字段",
    });
  }

  const localVersion = versionToNum(version);
  const remoteVersion = versionToNum(remoteJSON.version);

  if (remoteVersion > localVersion) {
    const forceUpdate = shouldForceUpdate(version, remoteJSON);
    await showNewVersionDialog(forceUpdate);
    return true;
  } else {
    return false;
  }
}

function parseTemplateVersion(html: string): number | null {
  const match =
    html.match(
      /<meta\b[^>]*\bname=["']evd-template-version["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i
    ) ||
    html.match(
      /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']evd-template-version["'][^>]*>/i
    );
  if (!match) return null;
  const raw = match[1].trim();
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function isLocalTemplateCompatible(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    const html = readFileSync(filePath, "utf-8");
    return parseTemplateVersion(html) === EVD_TEMPLATE_VERSION;
  } catch (e) {
    return false;
  }
}

const watchedForceHostWindows = new WeakSet<BrowserWindow>();
const watchedClosedHostWindows = new WeakSet<BrowserWindow>();
let isForceWindowGuardBound = false;

function watchHostWindowClosed(hostWindow: BrowserWindow) {
  if (
    !hostWindow ||
    hostWindow === activePromptWindow ||
    hostWindow.isDestroyed() ||
    watchedClosedHostWindows.has(hostWindow)
  ) {
    return;
  }
  watchedClosedHostWindows.add(hostWindow);
  hostWindow.on("closed", () => {
    const promptWindow = activePromptWindow;
    //  如果只剩下一个窗口，关闭自己
    if (
      promptWindow &&
      !promptWindow.isDestroyed() &&
      BrowserWindow.getAllWindows().length == 1
    ) {
      if (isForceUpdate) {
        if (!isRelaunching) {
          exitAppIfForceUpdateNotInstalling();
        }
      } else if (!isUpdating) {
        cleanup(promptWindow);
      }
    }
  });
}

function blockHostWindow(
  hostWindow: BrowserWindow,
  promptWindow: BrowserWindow
) {
  if (
    !isForceUpdate ||
    !hostWindow ||
    hostWindow === promptWindow ||
    hostWindow.isDestroyed()
  ) {
    return;
  }
  if (process.platform !== "darwin") {
    hostWindow.setEnabled(false);
  }
  hostWindow.hide();
  if (!promptWindow.isDestroyed()) {
    promptWindow.focus();
  }
}

function watchHostWindowInForceMode(
  hostWindow: BrowserWindow,
  promptWindow: BrowserWindow
) {
  if (!hostWindow || hostWindow === promptWindow || hostWindow.isDestroyed()) {
    return;
  }
  watchHostWindowClosed(hostWindow);
  if (!watchedForceHostWindows.has(hostWindow)) {
    watchedForceHostWindows.add(hostWindow);
    hostWindow.on("show", () => {
      if (activePromptWindow && !activePromptWindow.isDestroyed()) {
        blockHostWindow(hostWindow, activePromptWindow);
      }
    });
  }
}

function isInstallingFiles() {
  return isUpdating && activeTracker?.state.stage === "install";
}

function exitAppIfForceUpdateNotInstalling(): boolean {
  if (isInstallingFiles()) {
    return false;
  }
  const { onBeforeForceExit } = getConfigs();
  if (!onBeforeForceExit) {
    app.exit(0);
    return true;
  }
  if (isForceExitPending) return true;
  isForceExitPending = true;

  let isNextCalled = false;
  const next = () => {
    if (isNextCalled) return;
    isNextCalled = true;
    isForceExitPending = false;
    if (isInstallingFiles()) return;
    app.exit(0);
  };
  try {
    const maybePromise: any = onBeforeForceExit(next);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => next());
    }
  } catch (e) {
    next();
  }
  return true;
}

function handleForceAppWindowEvent(_event: unknown, window: BrowserWindow) {
  if (
    !isForceUpdate ||
    !activePromptWindow ||
    activePromptWindow.isDestroyed() ||
    window === activePromptWindow ||
    window.isDestroyed()
  ) {
    return;
  }
  watchHostWindowInForceMode(window, activePromptWindow);
  blockHostWindow(window, activePromptWindow);
}

function removeForceWindowGuardListeners() {
  if (!isForceWindowGuardBound) return;
  isForceWindowGuardBound = false;
  app.removeListener("browser-window-created", handleForceAppWindowEvent);
  app.removeListener("browser-window-focus", handleForceAppWindowEvent);
}

function applyForceUpdateWindowPolicy(promptWindow: BrowserWindow) {
  if (promptWindow.isDestroyed()) return;
  promptWindow.setSkipTaskbar(false);

  if (!isForceWindowGuardBound) {
    isForceWindowGuardBound = true;
    app.on("browser-window-created", handleForceAppWindowEvent);
    app.on("browser-window-focus", handleForceAppWindowEvent);
  }

  const allWindows = BrowserWindow.getAllWindows();
  allWindows.forEach((window) => {
    if (window === promptWindow || window.isDestroyed()) {
      return;
    }
    watchHostWindowInForceMode(window, promptWindow);
    blockHostWindow(window, promptWindow);
  });
}

async function showNewVersionDialog(forceUpdate = false) {
  const { windowHeight, windowWidth, onError } = getConfigs();

  await app.whenReady().then(async () => {
    try {
      if (activePromptWindow && !activePromptWindow.isDestroyed()) {
        if (forceUpdate && !isForceUpdate) {
          isForceUpdate = true;
          activePromptWindow.setTitle(FORCE_UPDATE_TITLE);
          notifyForceUpdateMode(activePromptWindow, true);
          applyForceUpdateWindowPolicy(activePromptWindow);
        }
        activePromptWindow.show();
        activePromptWindow.focus();
        return;
      }

      if (forceUpdate) {
        isForceUpdate = true;
      }
      isRelaunching = false;
      const initialTitle = isForceUpdate
        ? FORCE_UPDATE_TITLE
        : OPTIONAL_UPDATE_TITLE;

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
        skipTaskbar: !isForceUpdate,
        //  windows 11 如果设置为 true 会导致点击后马上消失
        alwaysOnTop: platform !== "win32",
        useContentSize: false,
        title: initialTitle,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
        },
        show: false,
      });

      activePromptWindow = promptWindow;

      if (isForceUpdate) {
        applyForceUpdateWindowPolicy(promptWindow);
      }

      promptWindow.setMenu(null);
      promptWindow.setMenuBarVisibility(false);
      //  模板 <title> 会触发 page-title-updated 覆盖构造参数中的 title
      promptWindow.on("page-title-updated", (event, title) => {
        const expectedTitle = isForceUpdate
          ? FORCE_UPDATE_TITLE
          : OPTIONAL_UPDATE_TITLE;
        if (title !== expectedTitle) {
          event.preventDefault();
          promptWindow.setTitle(expectedTitle);
        }
      });

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
      if (isLocalTemplateCompatible(nodeModulesTemplatePath)) {
        templatePath = nodeModulesTemplatePath;
      } else {
        templatePath = join(appPath, "_evdDialogTemplate.html");
        try {
          writeFileSync(templatePath, templateHtmlStr as string, "utf-8");
        } catch (e) {
          //  当 appPath 只读（例如 macOS DMG 或 App Translocation）时，回退到系统 temp 目录加载弹窗，确保弹窗仍能展示明确报错
          templatePath = join(app.getPath("temp"), "_evdDialogTemplate.html");
          writeFileSync(templatePath, templateHtmlStr as string, "utf-8");
        }
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

        const bindHostWindowsClosed = () => {
          BrowserWindow.getAllWindows().forEach((window) => {
            watchHostWindowClosed(window);
          });
        };

        bindHostWindowsClosed();
        setTimeout(bindHostWindowsClosed, 1000);
      });

      promptWindow.on("close", (event) => {
        if (!isForceUpdate || isRelaunching) {
          cleanup(promptWindow);
          return;
        }
        event.preventDefault();
        exitAppIfForceUpdateNotInstalling();
      });

      //  事件处理
      bindEvent(promptWindow, onError);
    } catch (e) {
      onError(toEVDError(e, { phase: EVDErrorPhaseEnum.CHECK }));
    }
  });
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

class UpdateProgressTracker {
  private promptWindow: BrowserWindow;
  private startedAt = Date.now();
  private lastActivityAt = Date.now();
  private lastSentAt = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private targetVersion = "";
  private appPath = app.getAppPath();
  private envSummary = describeRuntimeEnvironment(this.appPath);

  public state: EVDUpdateProgressPayload = {
    stage: "precheck",
    stageTitle: "正在检查更新环境...",
    percent: 2,
    progressText: "准备中",
    currentItem: this.appPath,
    elapsedSeconds: 0,
    stalled: false,
    stalledSeconds: 0,
    stalledReason: undefined,
    diagnosticText: "",
    stepValues: {
      precheck: "检查中...",
      download: "等待中",
      unzip: "等待中",
      install: "等待中",
      relaunch: "等待中",
    },
  };

  constructor(promptWindow: BrowserWindow) {
    this.promptWindow = promptWindow;
    this.watchdogTimer = setInterval(() => {
      this.tickWatchdog();
    }, 1000);
  }

  public setTargetVersion(version: string) {
    this.targetVersion = version;
  }

  public getPhase(): EVDErrorPhaseEnum {
    if (this.state.stage === "download") return EVDErrorPhaseEnum.DOWNLOAD;
    return EVDErrorPhaseEnum.INSTALL;
  }

  public getErrorContext() {
    return {
      phase: this.getPhase(),
      stage: this.state.stageTitle,
      progress: this.state.progressText,
      filePath: this.state.currentItem || undefined,
    };
  }

  public getExtraDiagnostics(): Record<string, unknown> {
    return {
      当前版本: cacheCurrentPkgJSON?.version,
      目标版本: this.targetVersion || undefined,
      更新地址: getConfigs().remoteUrl,
      运行环境: this.envSummary,
      已用时间: `${this.state.elapsedSeconds}s`,
    };
  }

  public update(
    patch: Partial<
      Omit<
        EVDUpdateProgressPayload,
        "elapsedSeconds" | "stalled" | "stalledSeconds" | "diagnosticText" | "stepValues"
      >
    > & {
      stepValues?: Partial<Record<EVDUpdateStageType, string>>;
    },
    force = true
  ) {
    const now = Date.now();
    this.lastActivityAt = now;
    this.state = {
      ...this.state,
      ...patch,
      stepValues: {
        ...this.state.stepValues,
        ...(patch.stepValues ?? {}),
      },
      elapsedSeconds: Math.floor((now - this.startedAt) / 1000),
      stalled: false,
      stalledSeconds: 0,
      stalledReason: undefined,
    };
    this.state.diagnosticText = this.buildDiagnosticText();

    if (!force && now - this.lastSentAt < PROGRESS_IPC_THROTTLE_MS) return;
    this.lastSentAt = now;
    this.send();
  }

  private tickWatchdog() {
    const now = Date.now();
    const idleMs = now - this.lastActivityAt;
    this.state.elapsedSeconds = Math.floor((now - this.startedAt) / 1000);

    if (idleMs >= STALL_THRESHOLD_MS) {
      const stalledSeconds = Math.floor(idleMs / 1000);
      this.state.stalled = true;
      this.state.stalledSeconds = stalledSeconds;
      this.state.stalledReason = this.buildStallReason(stalledSeconds);
    }
    this.state.diagnosticText = this.buildDiagnosticText();
    this.send();
  }

  private buildStallReason(stalledSeconds: number): string {
    const item = this.state.currentItem || "当前操作";
    switch (this.state.stage) {
      case "precheck":
        return `当前停留在「${item}」(已等待 ${stalledSeconds} 秒)。若应用定义了 onBeforeNewPkgInstall 回调，请确认是否已调用 next()。`;
      case "download":
        return `当前停留在下载「${item}」(已等待 ${stalledSeconds} 秒)，网络或代理连接可能较慢，可继续等待或复制诊断信息。`;
      case "unzip":
        return `当前停留在解压「${item}」(已等待 ${stalledSeconds} 秒)，macOS 安全扫描大量文件时可能较慢，可继续等待或复制诊断信息。`;
      case "install":
        return `当前停留在写入「${item}」(已等待 ${stalledSeconds} 秒)，可继续等待或复制诊断信息反馈。`;
      default:
        return `当前步骤已等待 ${stalledSeconds} 秒 (${item})。`;
    }
  }

  private buildDiagnosticText(): string {
    const lines: [string, unknown][] = [
      ["时间", new Date().toISOString()],
      ["平台", `${process.platform} ${process.arch}`],
      ["当前版本", cacheCurrentPkgJSON?.version],
      ["目标版本", this.targetVersion],
      ["更新地址", getConfigs().remoteUrl],
      ["当前阶段", `${this.state.stage} (${this.state.stageTitle})`],
      ["当前进度", `${this.state.progressText} (${this.state.percent}%)`],
      ["当前处理项", this.state.currentItem],
      ["已用时间", `${this.state.elapsedSeconds}s`],
      [
        "停顿状态",
        this.state.stalled
          ? `已停顿 ${this.state.stalledSeconds}s - ${this.state.stalledReason}`
          : "正常推进中",
      ],
      ["运行环境", this.envSummary],
    ];
    return ["[EVD 更新进度诊断]"]
      .concat(
        lines
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${k}: ${v}`)
      )
      .join("\n");
  }

  private send() {
    try {
      if (this.promptWindow.isDestroyed()) return;
      this.promptWindow.webContents.send(
        EVDEventEnum.UPDATE_PROGRESS,
        this.state
      );
    } catch (e) {}
  }

  public stop() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}

//  安装新版本
async function installNewVersion(
  tracker: UpdateProgressTracker,
  remoteJSON: any
) {
  const isDepsEqual = compareObjectsIsEqual(
    remoteJSON?.dependencies,
    cacheCurrentPkgJSON?.dependencies
  );

  await installPkg(
    !isDepsEqual ? FULL_CODE_ZIP_NAME : LOGIC_CODE_ZIP_NAME,
    tracker
  );
}

async function installPkg(zipFile: string, tracker: UpdateProgressTracker) {
  const { remoteUrl, requestTimeout, downloadStallTimeout } = getConfigs();
  const appPath = app.getAppPath();

  const unzipPath = join(appPath, "evdUnzip");
  const zipPath = unzipPath + ".zip";
  const installerFile = join(appPath, "_evdInstallerTmp.js");

  tracker.update({
    stage: "precheck",
    stageTitle: "正在准备本地解压目录...",
    percent: 8,
    progressText: "准备解压目录",
    currentItem: unzipPath,
  });

  // 如果路径存在，清空它
  try {
    if (existsSync(unzipPath)) {
      rmSync(unzipPath, {
        force: true,
        maxRetries: 3,
        recursive: true,
      });
    }
    mkdirSync(unzipPath, { recursive: true });
  } catch (error) {
    throw toEVDError(error, {
      phase: EVDErrorPhaseEnum.INSTALL,
      stage: "准备本地解压目录",
      filePath: unzipPath,
    });
  }

  try {
    const splitFolder =
      zipFile === FULL_CODE_ZIP_NAME
        ? SPLIT_FOLDER_NAME
        : LOGIC_SPLIT_FOLDER_NAME;
    let splitIndexList: false | string[] = false;
    tracker.update({
      stage: "download",
      stageTitle: "正在检查远程分片配置...",
      percent: 10,
      progressText: "探测分片索引",
      currentItem: `${splitFolder}/index.json`,
      stepValues: {
        download: "探测分片中...",
      },
    });
    try {
      splitIndexList = await netRequest({
        url: joinRemoteUrl(
          remoteUrl,
          `${splitFolder}/index.json?hash=${Math.random()}`
        ),
        responseType: "json",
        timeoutMs: requestTimeout,
        phase: EVDErrorPhaseEnum.DOWNLOAD,
      });
    } catch (e) {}

    if (Array.isArray(splitIndexList) && splitIndexList.length > 0) {
      const totalChunks = splitIndexList.length;
      const tmpFilePaths = splitIndexList.map((fileName) =>
        join(appPath, fileName)
      );

      try {
        for (const [index, fileName] of splitIndexList.entries()) {
          const chunkNum = index + 1;
          tracker.update({
            stage: "download",
            stageTitle: `正在下载更新包 (分片 ${chunkNum}/${totalChunks})...`,
            percent: Math.round(10 + ((chunkNum - 1) / totalChunks) * 32),
            completed: chunkNum - 1,
            total: totalChunks,
            progressText: `分片 ${chunkNum}/${totalChunks}`,
            currentItem: `${splitFolder}/${fileName}`,
            stepValues: {
              download: `分片 ${chunkNum}/${totalChunks}`,
            },
          });

          await downloadFile({
            url: joinRemoteUrl(
              remoteUrl,
              `${splitFolder}/${fileName}?hash=${Math.random()}`
            ),
            destPath: tmpFilePaths[index],
            stallTimeoutMs: downloadStallTimeout,
            onProgress: ({ loadedBytes, totalBytes }) => {
              const chunkRatio =
                totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 0;
              const overallRatio = (index + chunkRatio) / totalChunks;
              const sizeText =
                totalBytes > 0
                  ? `${formatMB(loadedBytes)} / ${formatMB(totalBytes)}`
                  : formatMB(loadedBytes);
              const label = `分片 ${chunkNum}/${totalChunks} (${sizeText})`;
              tracker.update(
                {
                  stage: "download",
                  stageTitle: `正在下载更新包 (分片 ${chunkNum}/${totalChunks})...`,
                  percent: Math.round(10 + overallRatio * 32),
                  completed: loadedBytes,
                  total: totalBytes || undefined,
                  progressText: label,
                  currentItem: `${splitFolder}/${fileName}`,
                  stepValues: {
                    download: label,
                  },
                },
                false
              );
            },
          });
        }

        tracker.update({
          stage: "download",
          stageTitle: "正在合并更新包分片...",
          percent: 44,
          progressText: `合并 ${totalChunks} 个分片`,
          currentItem: zipPath,
          stepValues: {
            download: `正在合并 ${totalChunks} 个分片...`,
          },
        });

        //  分片全部下载完成后再合并，避免中途失败留下半个包
        await new Promise<void>((res, rej) => {
          const mergedStream = createWriteStream(zipPath);
          mergedStream.on("error", rej);
          for (const tmpFilePath of tmpFilePaths) {
            mergedStream.write(readFileSync(tmpFilePath));
          }
          mergedStream.end(() => res());
        });

        tracker.update({
          stage: "download",
          stageTitle: "更新包下载完成",
          percent: 45,
          progressText: `✓ 已完成 (${totalChunks} 个分片)`,
          currentItem: zipFile,
          stepValues: {
            download: `✓ 已完成 (${totalChunks} 个分片)`,
          },
        });
      } finally {
        //  删除临时文件
        tmpFilePaths.filter(existsSync).forEach(forceDeleteSync);
      }
    } else {
      const pkgTypeLabel = zipFile === FULL_CODE_ZIP_NAME ? "全量包" : "增量包";
      let finalDownloadSizeText = pkgTypeLabel;
      tracker.update({
        stage: "download",
        stageTitle: `正在下载更新包 (${pkgTypeLabel})...`,
        percent: 10,
        progressText: `连接下载 ${zipFile}`,
        currentItem: zipFile,
        stepValues: {
          download: "下载中...",
        },
      });

      await downloadFile({
        url: joinRemoteUrl(remoteUrl, `${zipFile}?hash=${Math.random()}`),
        destPath: zipPath,
        stallTimeoutMs: downloadStallTimeout,
        onProgress: ({ loadedBytes, totalBytes }) => {
          const ratio =
            totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 0.5;
          finalDownloadSizeText =
            totalBytes > 0
              ? `${formatMB(loadedBytes)} / ${formatMB(totalBytes)}`
              : formatMB(loadedBytes);
          tracker.update(
            {
              stage: "download",
              stageTitle: `正在下载更新包 (${pkgTypeLabel})...`,
              percent: Math.round(10 + ratio * 35),
              completed: loadedBytes,
              total: totalBytes || undefined,
              progressText: finalDownloadSizeText,
              currentItem: zipFile,
              stepValues: {
                download: finalDownloadSizeText,
              },
            },
            false
          );
        },
      });

      tracker.update({
        stage: "download",
        stageTitle: "更新包下载完成",
        percent: 45,
        progressText: `✓ ${finalDownloadSizeText}`,
        currentItem: zipFile,
        stepValues: {
          download: `✓ ${finalDownloadSizeText}`,
        },
      });
    }

    //  解压
    let extractedCount = 0;
    let totalZipEntries = 0;
    let lastUnzipEntry = zipPath;

    tracker.update({
      stage: "unzip",
      stageTitle: "正在解压更新包...",
      percent: 46,
      progressText: "准备解压...",
      currentItem: zipPath,
      stepValues: {
        unzip: "解压中...",
      },
    });

    try {
      await extract(zipPath, {
        dir: unzipPath,
        onEntry(entry, zipfile) {
          extractedCount += 1;
          totalZipEntries = zipfile?.entryCount || totalZipEntries;
          lastUnzipEntry = entry.fileName;
          const ratio =
            totalZipEntries > 0
              ? Math.min(1, extractedCount / totalZipEntries)
              : 0.5;
          const countLabel =
            totalZipEntries > 0
              ? `${extractedCount} / ${totalZipEntries} 个条目`
              : `${extractedCount} 个条目`;
          tracker.update(
            {
              stage: "unzip",
              stageTitle: "正在解压更新包...",
              percent: Math.round(46 + ratio * 24),
              completed: extractedCount,
              total: totalZipEntries || undefined,
              progressText: countLabel,
              currentItem: entry.fileName,
              stepValues: {
                unzip: countLabel,
              },
            },
            extractedCount === 1 || extractedCount === totalZipEntries
          );
        },
      });
    } catch (error) {
      throw toEVDError(
        error,
        {
          phase: EVDErrorPhaseEnum.INSTALL,
          stage: "解压更新包",
          progress:
            totalZipEntries > 0
              ? `${extractedCount} / ${totalZipEntries} 个条目`
              : `${extractedCount} 个条目`,
          filePath: lastUnzipEntry,
        },
        EVDErrorCodeEnum.UNZIP_FAILED
      );
    }

    tracker.update({
      stage: "unzip",
      stageTitle: "更新包解压完成",
      percent: 70,
      completed: extractedCount,
      total: totalZipEntries || extractedCount,
      progressText: `✓ 共 ${totalZipEntries || extractedCount} 个条目`,
      currentItem: unzipPath,
      stepValues: {
        unzip: `✓ 共 ${totalZipEntries || extractedCount} 个条目`,
      },
    });

    //  等待解压完成，解压需要一定时间
    await new Promise((res) => setTimeout(res, 1000));

    //  创建一个临时的 _evdInstallerTmp.js 文件用于 fork 安装
    //  避免出现 window 下资源占用问题
    try {
      writeFileSync(
        installerFile,
        Object.entries({
          __unzipPath__: unzipPath,
          __appPath__: appPath,
        }).reduce((prev, current) => {
          const [key, value] = current;
          const normalized = value.split(sep).join("/");
          return prev.replace(key, () => normalized);
        }, installerCodeStr as string)
      );
    } catch (error) {
      throw toEVDError(error, {
        phase: EVDErrorPhaseEnum.INSTALL,
        stage: "创建安装脚本",
        filePath: installerFile,
      });
    }

    tracker.update({
      stage: "install",
      stageTitle: "正在扫描并更新本地文件...",
      percent: 72,
      progressText: "计算需更新的文件数...",
      currentItem: installerFile,
      stepValues: {
        install: "统计文件数...",
      },
    });

    //  开始执行安装
    const child = utilityProcess.fork(installerFile);
    let lastCopiedFiles = 0;
    let totalFilesToCopy = 0;
    let lastCopyingFile = appPath;
    let installTimeoutId: NodeJS.Timeout | null = null;

    //  等待子进程执行完毕，或者超过 5 分钟
    try {
      await Promise.race([
        new Promise<void>((res, rej) => {
          let installError: EVDError | null = null;
          let isDone = false;

          const buildInstallerEVDError = ({
            detail,
            filePath,
            completed,
            total,
            stack,
          }: {
            detail: string;
            filePath?: string;
            completed?: number;
            total?: number;
            stack?: string;
          }) => {
            const progressLabel =
              typeof total === "number" && total > 0
                ? `${completed ?? lastCopiedFiles} / ${total} 个文件`
                : undefined;
            return toEVDError(
              detail,
              {
                phase: EVDErrorPhaseEnum.INSTALL,
                stage: "更新本地文件",
                progress: progressLabel,
                filePath: filePath || lastCopyingFile,
                cause: detail,
                stack,
                message: detail || undefined,
              },
              EVDErrorCodeEnum.INSTALL_FAILED
            );
          };

          child.on("message", (msg: any) => {
            if (msg && typeof msg === "object") {
              if (msg.type === "progress") {
                lastCopiedFiles = Number(msg.completed) || 0;
                totalFilesToCopy = Number(msg.total) || 0;
                if (msg.currentFile) {
                  lastCopyingFile = msg.currentFile;
                }
                const ratio =
                  totalFilesToCopy > 0
                    ? Math.min(1, lastCopiedFiles / totalFilesToCopy)
                    : 0.5;
                const countText =
                  totalFilesToCopy > 0
                    ? `${lastCopiedFiles} / ${totalFilesToCopy} 个文件`
                    : `${lastCopiedFiles} 个文件`;
                tracker.update(
                  {
                    stage: "install",
                    stageTitle: "正在更新本地文件...",
                    percent: Math.round(72 + ratio * 26),
                    completed: lastCopiedFiles,
                    total: totalFilesToCopy || undefined,
                    progressText: countText,
                    currentItem: lastCopyingFile,
                    stepValues: {
                      install: countText,
                    },
                  },
                  lastCopiedFiles <= 1 || lastCopiedFiles === totalFilesToCopy
                );
                return;
              }

              if (msg.type === "error") {
                installError = buildInstallerEVDError({
                  detail: msg.message || String(msg.code || ""),
                  filePath: msg.filePath,
                  completed: msg.completed,
                  total: msg.total,
                  stack: msg.stack,
                });
                rej(installError);
                return;
              }

              if (msg.type === "done") {
                isDone = true;
                lastCopiedFiles = Number(msg.completed) || lastCopiedFiles;
                totalFilesToCopy = Number(msg.total) || totalFilesToCopy;
                res();
                return;
              }
            }

            if (
              typeof msg === "string" &&
              msg.startsWith(INSTALLER_FAILED_PREFIX)
            ) {
              const detail = msg.slice(INSTALLER_FAILED_PREFIX.length);
              installError = buildInstallerEVDError({ detail });
              rej(installError);
              return;
            }
            if (msg === INSTALLER_DONE_MESSAGE) {
              isDone = true;
              res();
            }
          });

          child.on("exit", (code) => {
            if (installError) {
              rej(installError);
              return;
            }
            if (!isDone && code && code !== 0) {
              rej(
                buildInstallerEVDError({
                  detail: `安装子进程异常退出 (exitCode=${code})`,
                  filePath: lastCopyingFile,
                  completed: lastCopiedFiles,
                  total: totalFilesToCopy,
                })
              );
              return;
            }
            res();
          });
        }),
        new Promise<void>((_, rej) => {
          installTimeoutId = setTimeout(() => {
            try {
              child.kill();
            } catch (e) {}
            rej(
              new EVDError(EVDErrorCodeEnum.INSTALL_FAILED, {
                phase: EVDErrorPhaseEnum.INSTALL,
                stage: "更新本地文件 (超时)",
                progress:
                  totalFilesToCopy > 0
                    ? `${lastCopiedFiles} / ${totalFilesToCopy} 个文件`
                    : undefined,
                filePath: lastCopyingFile,
                cause: "安装文件超时（超过 5 分钟未完成）",
              })
            );
          }, 5 * 60 * 1000);
        }),
      ]);
    } finally {
      if (installTimeoutId) {
        clearTimeout(installTimeoutId);
      }
    }

    tracker.update({
      stage: "relaunch",
      stageTitle: "更新完成，正在重启应用...",
      percent: 100,
      completed: totalFilesToCopy || lastCopiedFiles,
      total: totalFilesToCopy || lastCopiedFiles,
      progressText: `✓ 已更新 ${totalFilesToCopy || lastCopiedFiles} 个文件`,
      currentItem: "app.relaunch()",
      stepValues: {
        install: `✓ 共更新 ${totalFilesToCopy || lastCopiedFiles} 个文件`,
        relaunch: "正在重启...",
      },
    });
  } finally {
    for (const tmpTarget of [zipPath, unzipPath, installerFile]) {
      try {
        if (existsSync(tmpTarget)) {
          rmSync(tmpTarget, {
            recursive: true,
            force: true,
            maxRetries: 3,
          });
        }
      } catch (e) {}
    }
  }
}

function removeUpdateIpcListeners() {
  ipcMain.removeAllListeners(EVDEventEnum.OPEN_LINK);
  ipcMain.removeAllListeners(EVDEventEnum.SKIP);
  ipcMain.removeAllListeners(EVDEventEnum.UPDATE);
  ipcMain.removeHandler(EVDEventEnum.GET_CHANGELOGS);
  ipcMain.removeHandler(EVDEventEnum.GET_LOGO);
  ipcMain.removeHandler(EVDEventEnum.GET_CHANGELOGS_LINK);
  ipcMain.removeHandler(EVDEventEnum.GET_FORCE_UPDATE);
}

function notifyForceUpdateMode(
  promptWindow: BrowserWindow,
  forceUpdate: boolean
) {
  try {
    if (promptWindow.isDestroyed()) return;
    promptWindow.webContents.send(
      EVDEventEnum.FORCE_UPDATE_CHANGE,
      forceUpdate
    );
  } catch (e) {}
}

function bindEvent(promptWindow: BrowserWindow, onError) {
  const { logo, onBeforeNewPkgInstall, remoteUrl } = getConfigs();

  removeUpdateIpcListeners();

  ipcMain.on(EVDEventEnum.OPEN_LINK, (_, link) => {
    shell.openExternal(link);
  });

  ipcMain.on(EVDEventEnum.SKIP, (_) => {
    if (isForceUpdate) {
      exitAppIfForceUpdateNotInstalling();
      return;
    }
    promptWindow.close();
  });

  ipcMain.on(EVDEventEnum.UPDATE, async (_) => {
    if (isUpdating) return;
    isUpdating = true;

    const tracker = new UpdateProgressTracker(promptWindow);
    activeTracker = tracker;

    const handleUpdateFailed = (error: unknown) => {
      tracker.stop();
      if (activeTracker === tracker) {
        activeTracker = null;
      }
      isUpdating = false;
      const evdError = toEVDError(error, tracker.getErrorContext());
      onError(evdError);
      //  通知弹窗展示错误，否则遮罩会一直停在那里
      notifyUpdateError(promptWindow, evdError, tracker.getExtraDiagnostics());
    };

    try {
      const appPath = app.getAppPath();
      tracker.update({
        stage: "precheck",
        stageTitle: "正在检查更新环境与写入权限...",
        percent: 4,
        progressText: "检测目录权限",
        currentItem: appPath,
        stepValues: {
          precheck: "检测中...",
        },
      });

      detectUpdateEnvironment(appPath);

      const pkg = await fetchRemotePkgJSON(
        remoteUrl,
        getConfigs().requestTimeout
      );
      if (!pkg) {
        throw new EVDError(EVDErrorCodeEnum.REMOTE_NOT_FOUND, {
          phase: EVDErrorPhaseEnum.CHECK,
          stage: "获取远程版本信息",
          url: joinRemoteUrl(remoteUrl, "package.json"),
        });
      }

      if (
        cacheCurrentPkgJSON?.version &&
        shouldForceUpdate(cacheCurrentPkgJSON.version, pkg) &&
        !isForceUpdate
      ) {
        isForceUpdate = true;
        if (!promptWindow.isDestroyed()) {
          promptWindow.setTitle(FORCE_UPDATE_TITLE);
          notifyForceUpdateMode(promptWindow, true);
          applyForceUpdateWindowPolicy(promptWindow);
        }
      }

      tracker.setTargetVersion(pkg.version);
      tracker.update({
        stage: "precheck",
        stageTitle: "正在等待应用准备安装环境...",
        percent: 6,
        progressText: "等待 onBeforeNewPkgInstall",
        currentItem: "onBeforeNewPkgInstall",
        stepValues: {
          precheck: "等待应用回调...",
        },
      });

      await new Promise<void>((resolve, reject) => {
        try {
          const maybePromise: any = onBeforeNewPkgInstall(() => {
            resolve();
          }, pkg.version);
          if (maybePromise && typeof maybePromise.catch === "function") {
            maybePromise.catch(reject);
          }
        } catch (err) {
          reject(err);
        }
      });

      tracker.update({
        stage: "precheck",
        stageTitle: "更新环境检查通过",
        percent: 8,
        progressText: "✓ 环境检查通过",
        currentItem: appPath,
        stepValues: {
          precheck: "✓ 通过",
        },
      });

      await installNewVersion(tracker, pkg);

      tracker.stop();
      if (activeTracker === tracker) {
        activeTracker = null;
      }
      isUpdating = false;
      //  必须在 promptWindow.close() 前置位，否则强制模式下 close 会先于 app.relaunch() 触发 app.exit(0)
      isRelaunching = true;

      //  不知道什么情况会出现
      //  UnhandledRejection TypeError: Object has been destroyed
      setTimeout(() => promptWindow.close(), 1);
      setTimeout(() => app.relaunch(), 1);
      setTimeout(() => app.exit(), 1);
    } catch (error) {
      handleUpdateFailed(error);
    }
  });

  ipcMain.handle(EVDEventEnum.GET_FORCE_UPDATE, () => {
    return isForceUpdate;
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

function notifyUpdateError(
  promptWindow: BrowserWindow,
  error: EVDError,
  extraDiagnostics: Record<string, unknown> = {}
) {
  try {
    if (promptWindow.isDestroyed()) return;
    promptWindow.webContents.send(EVDEventEnum.UPDATE_ERROR, {
      code: error.code,
      phase: error.phase,
      stage: error.stage,
      progress: error.progress,
      filePath: error.filePath,
      message: error.message,
      detail: formatEVDErrorDetail(error, {
        当前版本: cacheCurrentPkgJSON?.version,
        更新地址: getConfigs().remoteUrl,
        ...extraDiagnostics,
      }),
    });
  } catch (e) {}
}

function cleanup(promptWindow: BrowserWindow) {
  removeUpdateIpcListeners();
  removeForceWindowGuardListeners();
  if (activeTracker) {
    activeTracker.stop();
    activeTracker = null;
  }
  isUpdating = false;
  if (!isRelaunching) {
    isForceUpdate = false;
  }
  if (activePromptWindow === promptWindow) {
    activePromptWindow = null;
  }

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
      onBeforeForceExit: undefined,
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
