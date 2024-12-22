import { net } from "electron";

interface RequestOptions {
  url: string;
  responseType?: 'json' | 'stream' | 'text';
}

export async function netRequest<T = any>(options: RequestOptions): Promise<T> {
  // 如果 net 不存在，使用 fetch
  if (!net) {
    const response = await fetch(options.url);
    
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
  }

  // 使用 net.request
  return new Promise((resolve, reject) => {
    const request = net.request(options.url);
    let data = '';

    request.on('response', (response) => {
      response.on('data', (chunk) => {
        if (options.responseType === 'stream') {
          resolve(response as any);
          return;
        }
        data += chunk;
      });

      response.on('end', () => {
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
      reject(error);
    });

    request.end();
  });
} 