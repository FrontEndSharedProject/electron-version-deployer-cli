import { net } from "electron";
import {
  EVDError,
  EVDErrorCodeEnum,
  EVDErrorPhaseEnum,
} from "@/types/EVDErrorType";
import { httpStatusError, timeoutCodeOf, toEVDError } from "./toEVDError";

interface RequestOptions {
  url: string;
  responseType?: "json" | "text";
  timeoutMs?: number;
  phase?: EVDErrorPhaseEnum;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

export async function netRequest<T = any>(options: RequestOptions): Promise<T> {
  const {
    url,
    responseType,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    phase = EVDErrorPhaseEnum.CHECK,
  } = options;
  const ctx = { phase, url };

  const text = net
    ? await requestByElectronNet(url, timeoutMs, ctx)
    : await requestByFetch(url, timeoutMs, ctx);

  if (responseType !== "json") return text as T;

  try {
    return JSON.parse(text) as T;
  } catch (e) {
    //  静态服务器常见行为：文件不存在时返回 200 + HTML 兜底页
    throw new EVDError(EVDErrorCodeEnum.REMOTE_INVALID_JSON, {
      ...ctx,
      cause: e,
    });
  }
}

async function requestByFetch(
  url: string,
  timeoutMs: number,
  ctx: { phase: EVDErrorPhaseEnum; url: string }
) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: abortController.signal });
    if (!response.ok) throw httpStatusError(response.status, ctx);
    return await response.text();
  } catch (error) {
    throw toEVDError(error, ctx);
  } finally {
    clearTimeout(timeoutId);
  }
}

function requestByElectronNet(
  url: string,
  timeoutMs: number,
  ctx: { phase: EVDErrorPhaseEnum; url: string }
) {
  return new Promise<string>((resolve, reject) => {
    const request = net.request(url);
    request.setHeader("Accept-Encoding", "identity");
    request.setHeader("Cache-Control", "no-cache");
    let data = "";
    let isSettled = false;

    const settle = (fn: () => void) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutId);
      fn();
    };

    const timeoutId = setTimeout(() => {
      request.abort();
      settle(() => reject(new EVDError(timeoutCodeOf(ctx.phase), { ...ctx })));
    }, timeoutMs);

    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        request.abort();
        settle(() => reject(httpStatusError(statusCode, ctx)));
        return;
      }

      response.on("data", (chunk) => {
        data += chunk;
      });

      response.on("end", () => {
        settle(() => resolve(data));
      });

      response.on("error", (error: unknown) => {
        settle(() => reject(toEVDError(error, ctx)));
      });
    });

    request.on("error", (error) => {
      settle(() => reject(toEVDError(error, ctx)));
    });

    request.end();
  });
}
