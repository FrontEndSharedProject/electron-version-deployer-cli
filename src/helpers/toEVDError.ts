import { accessSync, constants, statSync } from "node:fs";
import {
  EVDError,
  EVDErrorCodeEnum,
  EVDErrorContext,
  EVDErrorPhaseEnum,
  isEVDError,
} from "@/types/EVDErrorType";

//  electron net 与 node 两套错误标识，统一按关键字匹配
const UNREACHABLE_PATTERNS = [
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_FAILED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_PROXY_CONNECTION_FAILED",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
];

const TIMEOUT_PATTERNS = [
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_TIMED_OUT",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
];

const SSL_PATTERNS = [
  "ERR_CERT_",
  "ERR_SSL_",
  "ERR_BAD_SSL_CLIENT_AUTH_CERT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
];

const PERMISSION_CODES = ["EPERM", "EACCES"];
const READ_ONLY_CODES = ["EROFS"];
const DISK_FULL_CODES = ["ENOSPC"];

function matchAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}

//  只认带 path 的文件系统错误，socket 的 connect EACCES 不算；安装子进程回传的是 "EPERM: ..." 纯文本或对象
export function isPermissionError(error: unknown): boolean {
  return [error, (error as any)?.cause].some((item: any) =>
    typeof item === "string"
      ? /\b(EPERM|EACCES)\b/.test(item)
      : PERMISSION_CODES.includes(item?.code) &&
        (typeof item?.path === "string" || typeof item?.filePath === "string")
  );
}

export function isReadOnlyError(error: unknown): boolean {
  return [error, (error as any)?.cause].some((item: any) =>
    typeof item === "string"
      ? /\bEROFS\b/.test(item)
      : READ_ONLY_CODES.includes(item?.code)
  );
}

export function isDiskFullError(error: unknown): boolean {
  return [error, (error as any)?.cause].some((item: any) =>
    typeof item === "string"
      ? /\bENOSPC\b/.test(item)
      : DISK_FULL_CODES.includes(item?.code)
  );
}

/**
 * 仅做环境探测（不修改系统设置或强行绕过）：
 * 检测 macOS App Translocation 只读沙盒、DMG 只读卷挂载以及应用目录可写权限
 */
export function detectUpdateEnvironment(appPath: string) {
  const baseCtx: EVDErrorContext = {
    phase: EVDErrorPhaseEnum.INSTALL,
    stage: "环境与权限检查",
    filePath: appPath,
  };

  if (
    process.platform === "darwin" &&
    appPath.includes("/AppTranslocation/")
  ) {
    throw new EVDError(EVDErrorCodeEnum.APP_TRANSLOCATION, baseCtx);
  }

  try {
    accessSync(appPath, constants.W_OK);
  } catch (err: any) {
    throw toEVDError(err, baseCtx);
  }
}

/**
 * 采集当前应用路径的电脑环境摘要，供错误详情和复制诊断信息使用
 */
export function describeRuntimeEnvironment(appPath: string): string {
  const parts: string[] = [`appPath=${appPath}`];
  if (process.platform === "darwin") {
    parts.push(`AppTranslocation=${appPath.includes("/AppTranslocation/")}`);
    parts.push(`inVolumes=${appPath.startsWith("/Volumes/")}`);
  }
  try {
    const st = statSync(appPath);
    parts.push(`mode=0o${(st.mode & 0o777).toString(8)}`);
    if (typeof process.getuid === "function") {
      parts.push(`uid=${process.getuid()}/owner=${st.uid}`);
    }
  } catch (e) {}
  return parts.join(" | ");
}

/**
 * 把各种原始错误归一成 EVDError
 */
export function toEVDError(
  error: unknown,
  ctx: EVDErrorContext,
  fallbackCode?: EVDErrorCodeEnum
): EVDError {
  if (isEVDError(error)) {
    if (
      (ctx.stage && !error.stage) ||
      (ctx.progress && !error.progress) ||
      (ctx.filePath && !error.filePath)
    ) {
      return new EVDError(error.code, {
        phase: error.phase,
        url: error.url ?? ctx.url,
        statusCode: error.statusCode ?? ctx.statusCode,
        cause: error.cause ?? ctx.cause,
        stage: error.stage ?? ctx.stage,
        progress: error.progress ?? ctx.progress,
        filePath: error.filePath ?? ctx.filePath,
        stack: error.stack ?? ctx.stack,
        message: error.message,
      });
    }
    return error;
  }

  const raw = error as any;
  //  node fetch 把真实原因藏在 cause 里
  const text = [
    raw?.name,
    raw?.code,
    raw?.errno,
    raw?.message,
    raw?.cause?.code,
    raw?.cause?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  const detectedFilePath =
    (typeof raw?.filePath === "string" && raw.filePath
      ? raw.filePath
      : undefined) ??
    (typeof raw?.path === "string" && raw.path ? raw.path : undefined) ??
    (typeof raw?.cause?.path === "string" && raw.cause.path
      ? raw.cause.path
      : undefined) ??
    ctx.filePath;

  const detectedStack =
    ctx.stack ??
    (typeof raw?.stack === "string" ? raw.stack : undefined) ??
    (typeof raw?.cause?.stack === "string" ? raw.cause.stack : undefined);

  const context: EVDErrorContext = {
    ...ctx,
    filePath: detectedFilePath,
    stack: detectedStack,
    cause: ctx.cause ?? error,
    message: undefined,
  };

  if (isReadOnlyError(error)) {
    return new EVDError(EVDErrorCodeEnum.READ_ONLY_VOLUME, context);
  }

  if (isDiskFullError(error)) {
    return new EVDError(EVDErrorCodeEnum.DISK_FULL, context);
  }

  if (isPermissionError(error)) {
    return new EVDError(EVDErrorCodeEnum.PERMISSION_DENIED, context);
  }

  if (fallbackCode) {
    return new EVDError(fallbackCode, {
      ...context,
      message: ctx.message,
    });
  }

  if (raw?.name === "AbortError" || matchAny(text, TIMEOUT_PATTERNS)) {
    return new EVDError(timeoutCodeOf(ctx.phase), context);
  }

  if (matchAny(text, SSL_PATTERNS)) {
    return new EVDError(EVDErrorCodeEnum.SSL_ERROR, context);
  }

  if (matchAny(text, UNREACHABLE_PATTERNS)) {
    return new EVDError(EVDErrorCodeEnum.NETWORK_UNREACHABLE, context);
  }

  if (ctx.phase === EVDErrorPhaseEnum.DOWNLOAD) {
    return new EVDError(EVDErrorCodeEnum.DOWNLOAD_FAILED, context);
  }

  return new EVDError(EVDErrorCodeEnum.UNKNOWN, context);
}

export function timeoutCodeOf(phase: EVDErrorPhaseEnum) {
  return phase === EVDErrorPhaseEnum.DOWNLOAD
    ? EVDErrorCodeEnum.DOWNLOAD_TIMEOUT
    : EVDErrorCodeEnum.NETWORK_TIMEOUT;
}

/**
 * 非 2xx 响应对应的错误
 */
export function httpStatusError(statusCode: number, ctx: EVDErrorContext) {
  return new EVDError(
    statusCode === 404
      ? EVDErrorCodeEnum.REMOTE_NOT_FOUND
      : EVDErrorCodeEnum.HTTP_ERROR,
    { ...ctx, statusCode }
  );
}
