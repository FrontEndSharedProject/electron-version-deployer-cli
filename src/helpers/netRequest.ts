import { net } from "electron";

interface RequestOptions {
  url: string;
  responseType?: 'json' | 'stream' | 'text';
}

export async function netRequest<T = any>(options: RequestOptions): Promise<T> {
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