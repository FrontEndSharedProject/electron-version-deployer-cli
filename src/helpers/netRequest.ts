import { net } from "electron";

interface RequestOptions {
  url: string;
  responseType?: 'json' | 'stream' | 'text';
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
      
      if (options.responseType === 'json') {
        try {
          return await response.json();
        } catch (e) {
          return null as T;
        }
      } else if (options.responseType === 'stream') {
        return response.body as T;
      } else {
        return await response.text() as T;
      }
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('网络请求超时，请检查网络连接或使用 VPN 后重试');
      }
      throw error;
    }
  }

  // 使用 net.request
  return new Promise((resolve, reject) => {
    const request = net.request(options.url);
    let data = '';
    let isResolved = false;

    // 设置超时
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        request.abort();
        reject(new Error('网络请求超时，请检查网络连接或使用 VPN 后重试'));
      }
    }, TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeoutId);
    };

    request.on('response', (response) => {
      response.on('data', (chunk) => {
        if (options.responseType === 'stream') {
          if (!isResolved) {
            isResolved = true;
            cleanup();
            resolve(response as any);
          }
          return;
        }
        data += chunk;
      });

      response.on('end', () => {
        if (isResolved) return;
        isResolved = true;
        cleanup();
        
        if (options.responseType === 'stream') return;
        
        if (options.responseType === 'json') {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(null as T);
          }
        } else {
          resolve(data as T);
        }
      });
    });

    request.on('error', (error) => {
      if (!isResolved) {
        isResolved = true;
        cleanup();
        reject(error);
      }
    });

    request.end();
  });
} 