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

function matchAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}

/**
 * 把各种原始错误归一成 EVDError
 */
export function toEVDError(error: unknown, ctx: EVDErrorContext): EVDError {
  if (isEVDError(error)) return error;

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

  const context = { ...ctx, cause: ctx.cause ?? error, message: undefined };

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
