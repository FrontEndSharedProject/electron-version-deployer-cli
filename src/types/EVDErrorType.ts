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
  [EVDErrorCodeEnum.NOT_INITIALIZED]: "必须先执行 EVDInit 后才能继续运行！",
  [EVDErrorCodeEnum.UNKNOWN]: "更新失败，请稍后重试",
};

export type EVDErrorContext = {
  phase: EVDErrorPhaseEnum;
  url?: string;
  statusCode?: number;
  cause?: unknown;
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

  constructor(code: EVDErrorCodeEnum, ctx: EVDErrorContext) {
    super(ctx.message ?? EVD_ERROR_MESSAGES[code]);
    this.name = "EVDError";
    this.code = code;
    this.phase = ctx.phase;
    this.url = ctx.url;
    this.statusCode = ctx.statusCode;
    this.cause = ctx.cause;
  }

  toString() {
    const detail = [this.code, this.url, this.statusCode]
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
    ["错误码", raw?.code],
    ["提示", raw?.message],
    ...Object.entries(extra),
    ["地址", raw?.url],
    ["状态码", raw?.statusCode],
    ["原始错误", cause?.message ?? cause?.code ?? cause],
    ["堆栈", raw?.stack],
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
