export enum EVDErrorCodeEnum {
  //  请求超时（常见于需要 VPN 才能访问的域名）
  NETWORK_TIMEOUT = "NETWORK_TIMEOUT",
  //  DNS 解析失败 / 连接被拒绝 / 断网
  NETWORK_UNREACHABLE = "NETWORK_UNREACHABLE",
  //  证书错误，自建服务器使用自签名证书时常见
  SSL_ERROR = "SSL_ERROR",
  //  非 2xx 响应
  HTTP_ERROR = "HTTP_ERROR",
  //  404，远程未部署过或地址填错
  REMOTE_NOT_FOUND = "REMOTE_NOT_FOUND",
  //  拿到了响应但不是合法 JSON，静态服务器返回兜底页时常见
  REMOTE_INVALID_JSON = "REMOTE_INVALID_JSON",
  //  下载过程中长时间没有新数据
  DOWNLOAD_TIMEOUT = "DOWNLOAD_TIMEOUT",
  DOWNLOAD_FAILED = "DOWNLOAD_FAILED",
  UNZIP_FAILED = "UNZIP_FAILED",
  INSTALL_FAILED = "INSTALL_FAILED",
  //  没有权限写入安装目录，Windows 下常见于装在 C:\Program Files，macOS 下常见于未授予 App 管理权限或 root 属主
  PERMISSION_DENIED = "PERMISSION_DENIED",
  //  在只读卷或 macOS DMG 镜像中直接运行
  READ_ONLY_VOLUME = "READ_ONLY_VOLUME",
  //  macOS Gatekeeper App Translocation 随机只读沙盒
  APP_TRANSLOCATION = "APP_TRANSLOCATION",
  //  磁盘剩余空间不足 (ENOSPC)
  DISK_FULL = "DISK_FULL",
  //  未调用 EVDInit 就使用其它方法
  NOT_INITIALIZED = "NOT_INITIALIZED",
  UNKNOWN = "UNKNOWN",
}

export enum EVDErrorPhaseEnum {
  //  后台检测更新
  CHECK = "check",
  //  下载更新包
  DOWNLOAD = "download",
  //  解压与安装
  INSTALL = "install",
}

export const EVD_ERROR_MESSAGES: Record<EVDErrorCodeEnum, string> = {
  [EVDErrorCodeEnum.NETWORK_TIMEOUT]:
    "连接服务器超时，请检查网络连接，若该地址需要 VPN 请先连接后重试",
  [EVDErrorCodeEnum.NETWORK_UNREACHABLE]:
    "无法连接到服务器，请检查网络连接，若该地址需要 VPN 请先连接后重试",
  [EVDErrorCodeEnum.SSL_ERROR]: "服务器证书校验失败，请联系管理员检查证书配置",
  [EVDErrorCodeEnum.HTTP_ERROR]: "服务器返回异常，请稍后重试",
  [EVDErrorCodeEnum.REMOTE_NOT_FOUND]:
    "服务器上找不到更新文件，请联系管理员确认是否已发布新版本",
  [EVDErrorCodeEnum.REMOTE_INVALID_JSON]:
    "服务器返回的内容格式不正确，请联系管理员检查更新地址配置",
  [EVDErrorCodeEnum.DOWNLOAD_TIMEOUT]: "下载更新包超时，请检查网络连接后重试",
  [EVDErrorCodeEnum.DOWNLOAD_FAILED]: "下载更新包失败，请检查网络连接后重试",
  [EVDErrorCodeEnum.UNZIP_FAILED]: "更新包解压失败，请重试",
  [EVDErrorCodeEnum.INSTALL_FAILED]: "更新包安装失败，请重试",
  [EVDErrorCodeEnum.PERMISSION_DENIED]:
    process.platform === "win32"
      ? "没有权限写入软件安装目录，请完全退出软件后，右键点击软件图标选择「以管理员身份运行」，再重新更新"
      : process.platform === "darwin"
      ? "没有权限写入应用安装目录（可能未授予「App 管理」权限或目录属于管理员账号）。请前往「系统设置 → 隐私与安全性 → App 管理」开启本软件权限，或重新下载新版安装包覆盖安装"
      : "没有权限写入软件安装目录，请检查安装目录的写入权限后重试",
  [EVDErrorCodeEnum.READ_ONLY_VOLUME]:
    "当前软件正在只读磁盘或 DMG 安装镜像中运行，无法写入更新。请先将软件拖入「应用程序 (/Applications)」文件夹后再打开更新",
  [EVDErrorCodeEnum.APP_TRANSLOCATION]:
    "当前软件处于 macOS 安全隔离只读沙盒 (App Translocation) 中，无法原地更新。请在 Finder 中将软件移入「应用程序 (/Applications)」文件夹后重新打开",
  [EVDErrorCodeEnum.DISK_FULL]:
    "磁盘剩余空间不足，无法解压或写入更新文件，请清理磁盘空间后重试",
  [EVDErrorCodeEnum.NOT_INITIALIZED]: "必须先执行 EVDInit 后才能继续运行！",
  [EVDErrorCodeEnum.UNKNOWN]: "更新失败，请稍后重试",
};

export type EVDErrorContext = {
  phase: EVDErrorPhaseEnum;
  url?: string;
  statusCode?: number;
  cause?: unknown;
  //  具体子阶段描述（如：环境预检 / 下载更新包 / 解压更新包 / 覆盖安装文件）
  stage?: string;
  //  当前进度描述（如：965 / 1420 个文件）
  progress?: string;
  //  当前或失败时停留的文件路径
  filePath?: string;
  //  自定义或子进程透传的错误堆栈
  stack?: string;
  //  不传则使用 EVD_ERROR_MESSAGES 中的默认文案
  message?: string;
};

export class EVDError extends Error {
  //  打包后跨 bundle 时 instanceof 可能失效，用实例标记位兜底
  readonly isEVDError = true;
  readonly code: EVDErrorCodeEnum;
  readonly phase: EVDErrorPhaseEnum;
  readonly url?: string;
  readonly statusCode?: number;
  readonly cause?: unknown;
  readonly stage?: string;
  readonly progress?: string;
  readonly filePath?: string;

  constructor(code: EVDErrorCodeEnum, ctx: EVDErrorContext) {
    super(ctx.message ?? EVD_ERROR_MESSAGES[code]);
    this.name = "EVDError";
    this.code = code;
    this.phase = ctx.phase;
    this.url = ctx.url;
    this.statusCode = ctx.statusCode;
    this.cause = ctx.cause;
    this.stage = ctx.stage;
    this.progress = ctx.progress;
    this.filePath = ctx.filePath;
    if (ctx.stack) {
      this.stack = ctx.stack;
    }
  }

  toString() {
    const detail = [this.code, this.url, this.statusCode, this.filePath]
      .filter(Boolean)
      .join(" ");
    return `EVDError: ${this.message} (${detail})`;
  }
}

export function isEVDError(error: unknown): error is EVDError {
  return (
    !!error && typeof error === "object" && (error as any).isEVDError === true
  );
}

/**
 * 生成可直接复制给开发者排查的完整错误信息
 */
export function formatEVDErrorDetail(
  error: unknown,
  extra: Record<string, unknown> = {}
): string {
  const raw = error as any;
  const cause = raw?.cause;
  const lines: [string, unknown][] = [
    ["时间", new Date().toISOString()],
    ["平台", `${process.platform} ${process.arch}`],
    ["阶段", raw?.phase],
    ["子步骤", raw?.stage],
    ["错误码", raw?.code],
    ["提示", raw?.message],
    ["当前进度", raw?.progress],
    ["卡在文件", raw?.filePath],
    ...Object.entries(extra),
    ["地址", raw?.url],
    ["状态码", raw?.statusCode],
    ["原始错误", cause?.message ?? cause?.code ?? cause],
    ["堆栈", (typeof cause?.stack === "string" ? cause.stack : undefined) ?? raw?.stack],
  ];

  return ["[EVD 更新错误]"]
    .concat(
      lines
        .filter(
          ([, value]) => value !== undefined && value !== null && value !== ""
        )
        .map(([label, value]) => `${label}: ${value}`)
    )
    .join("\n");
}
