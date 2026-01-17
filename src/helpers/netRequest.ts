import { net } from "electron";

interface RequestOptions {
  url: string;
  responseType?: "json" | "stream" | "text";
}

const TIMEOUT_MS = 5000; // 5秒超时

export async function netRequest<T = any>(options: RequestOptions): Promise<T> {
  // 如果 net 不存在，使用 fetch
  if (!net) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, TIMEOUT_MS);

    try {
      const response = await fetch(options.url, {
        signal: abortController.signal,
      });
      clearTimeout(timeoutId);

      if (options.responseType === "json") {
        try {
          return await response.json();
        } catch (e) {
          return null as T;
        }
      } else if (options.responseType === "stream") {
        return response.body as T;
      } else {
        return (await response.text()) as T;
      }
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error("网络请求超时，请检查网络连接或使用 VPN 后重试");
      }
      throw error;
    }
  }

  // 使用 net.request
  return new Promise((resolve, reject) => {
    const request = net.request(options.url);
    request.setHeader("Accept-Encoding", "identity");
    request.setHeader("Cache-Control", "no-cache");
    let data = "";
    let isResolved = false;

    const failOnce = (error: unknown) => {
      if (isResolved) return;
      isResolved = true;
      cleanup();
      reject(error);
    };

    // 设置超时
    const timeoutId = setTimeout(() => {
      request.abort();
      failOnce(new Error("网络请求超时，请检查网络连接或使用 VPN 后重试"));
    }, TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeoutId);
    };

    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        failOnce(
          new Error(
            `请求失败，状态码: ${statusCode} ${response.statusMessage ?? ""}`.trim()
          )
        );
        return;
      }

      response.on("data", (chunk) => {
        try {
          if (options.responseType === "stream") {
            if (!isResolved) {
              isResolved = true;
              cleanup();
              resolve(response as any);
            }
            return;
          }
          data += chunk;
        } catch (error) {
          failOnce(error);
        }
      });

      response.on("end", () => {
        if (isResolved) return;
        isResolved = true;
        cleanup();

        if (options.responseType === "stream") return;

        try {
          if (options.responseType === "json") {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve(null as T);
            }
          } else {
            resolve(data as T);
          }
        } catch (error) {
          failOnce(error);
        }
      });

      response.on("error", (error) => {
        failOnce(error);
      });
    });

    request.on("error", (error) => {
      failOnce(error);
    });

    request.end();
  });
}
