/**
 * CLI 侧的远程探测
 *
 * 不复用 src/helpers/netRequest.ts：那个依赖 electron 的 net 模块，
 * 在 CLI 环境下靠 net 为 undefined 走 fetch 兜底，且超时写死、无法绕过缓存。
 */

export type RemoteJSONResult<T> = {
  //  取到并解析成功时为数据，否则为 null
  data: T | null;
  status: number;
  //  data 为 null 时的原因描述
  reason?: string;
};

export type ProbeResult = {
  ok: boolean;
  status: number;
  size?: number;
};

type RequestOptions = {
  timeoutMs?: number;
  //  绕过 CDN 缓存，上传后紧接着校验时必须开启
  noCache?: boolean;
};

const DEFAULT_TIMEOUT_MS = 10000;

export function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function withCacheBuster(url: string, noCache?: boolean) {
  if (!noCache) return url;
  return `${url}${url.includes("?") ? "&" : "?"}hash=${Date.now()}`;
}

function buildHeaders(noCache?: boolean): Record<string, string> {
  return noCache ? { "Cache-Control": "no-cache", Pragma: "no-cache" } : {};
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: abortController.signal });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时(${timeoutMs}ms): ${url}`);
    }
    //  node 的 fetch 把 ECONNREFUSED 等真实原因放在 cause 里
    const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
    throw new Error(`请求失败: ${url} ${error?.message ?? error}${cause}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 拉取远程 JSON
 * 文件不存在或内容不是合法 JSON 时返回 data: null，网络不通/超时则抛错
 */
export async function fetchRemoteJSON<T = any>(
  url: string,
  opts: RequestOptions = {}
): Promise<RemoteJSONResult<T>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, noCache } = opts;
  const response = await request(
    withCacheBuster(url, noCache),
    { headers: buildHeaders(noCache) },
    timeoutMs
  );

  if (response.status === 404) {
    return { data: null, status: 404, reason: "文件不存在(404)" };
  }

  if (!response.ok) {
    return {
      data: null,
      status: response.status,
      reason: `状态码 ${response.status}`,
    };
  }

  const text = await response.text();
  try {
    return { data: JSON.parse(text) as T, status: response.status };
  } catch (e) {
    //  静态服务器常见行为：文件不存在时返回 200 + HTML 兜底页
    return {
      data: null,
      status: response.status,
      reason: "响应内容不是合法 JSON",
    };
  }
}

/**
 * 探测远程文件是否可访问
 * 部分静态服务器不支持 HEAD，此时退回 Range GET
 */
export async function probeRemoteFile(
  url: string,
  opts: RequestOptions = {}
): Promise<ProbeResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, noCache } = opts;
  const finalUrl = withCacheBuster(url, noCache);
  const headers = buildHeaders(noCache);

  const headResponse = await request(
    finalUrl,
    { method: "HEAD", headers },
    timeoutMs
  );

  if (headResponse.status !== 405 && headResponse.status !== 501) {
    return {
      ok: headResponse.ok,
      status: headResponse.status,
      size: parseSize(headResponse),
    };
  }

  const rangeResponse = await request(
    finalUrl,
    { method: "GET", headers: { ...headers, Range: "bytes=0-0" } },
    timeoutMs
  );

  return {
    ok: rangeResponse.ok,
    status: rangeResponse.status,
    size: parseSize(rangeResponse),
  };
}

function parseSize(response: Response): number | undefined {
  const contentRange = response.headers.get("content-range");
  if (contentRange) {
    const total = contentRange.split("/").pop();
    if (total && /^\d+$/.test(total)) return Number(total);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength))
    return Number(contentLength);

  return undefined;
}
