import { net } from "electron";
import { createWriteStream } from "node:fs";
import { EVDError, EVDErrorPhaseEnum } from "@/types/EVDErrorType";
import { httpStatusError, timeoutCodeOf, toEVDError } from "./toEVDError";

export const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 60000;

/**
 * 下载远程文件到本地
 * 用「停顿超时」而非总时长超时，避免慢速网络下载大包被误杀
 */
export function downloadFile(props: {
  url: string;
  destPath: string;
  stallTimeoutMs?: number;
  onProgress?: (progress: { loadedBytes: number; totalBytes: number }) => void;
}) {
  const {
    url,
    destPath,
    stallTimeoutMs = DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
    onProgress,
  } = props;
  const ctx = { phase: EVDErrorPhaseEnum.DOWNLOAD, url };

  return new Promise<void>((resolve, reject) => {
    const fileStream = createWriteStream(destPath);
    const request = net.request({ url, method: "GET" });
    request.setHeader("Accept-Encoding", "identity");
    request.setHeader("Cache-Control", "no-cache");

    let isSettled = false;
    let stallTimeoutId: NodeJS.Timeout;

    const settle = (fn: () => void) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(stallTimeoutId);
      fn();
    };

    const fail = (error: unknown) => {
      settle(() => {
        request.abort();
        fileStream.destroy();
        reject(toEVDError(error, ctx));
      });
    };

    const resetStallTimer = () => {
      clearTimeout(stallTimeoutId);
      stallTimeoutId = setTimeout(() => {
        settle(() => {
          request.abort();
          fileStream.destroy();
          reject(new EVDError(timeoutCodeOf(ctx.phase), ctx));
        });
      }, stallTimeoutMs);
    };

    resetStallTimer();

    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      //  不校验状态码的话，404 返回的 HTML 页会被原样写进 zip
      if (statusCode < 200 || statusCode >= 300) {
        fail(httpStatusError(statusCode, ctx));
        return;
      }

      const rawContentLength = response.headers?.["content-length"];
      const contentLengthStr = Array.isArray(rawContentLength)
        ? rawContentLength[0]
        : rawContentLength;
      const totalBytes = Number(contentLengthStr) || 0;
      let loadedBytes = 0;

      if (onProgress) {
        onProgress({ loadedBytes: 0, totalBytes });
      }

      //  交给 pipe 写入以保留背压，data 监听用来判断是否停顿并统计下载进度
      response.on("data", (chunk: Buffer) => {
        resetStallTimer();
        loadedBytes += chunk?.length ?? 0;
        if (onProgress) {
          onProgress({ loadedBytes, totalBytes });
        }
      });
      response.on("aborted", () =>
        fail(new Error("ERR_CONNECTION_CLOSED: response aborted"))
      );
      response.on("error", (error: unknown) => fail(error));

      //  @ts-ignore electron 的 IncomingMessage 是 node Readable
      response.pipe(fileStream).on("finish", () => {
        settle(() => fileStream.end(() => resolve()));
      });
    });

    request.on("error", (error) => fail(error));
    fileStream.on("error", (error) => fail(error));

    request.end();
  });
}
