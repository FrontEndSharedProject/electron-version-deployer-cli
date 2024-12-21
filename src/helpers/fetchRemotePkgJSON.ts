import { net } from "electron";

export function fetchRemoteChangelogJSON(remote_url: string): Promise<any> {
  return new Promise<Object>((res, rej) => {
    const request = net.request(`${remote_url}/changelog.json`);

    let data = "";

    request.on('response', (response) => {
      // 处理响应数据
      response.on('data', (chunk) => {
        data += chunk;
      });

      // 响应数据接收完毕
      response.on('end', () => {
        try {
          res(JSON.parse(data));
        } catch (e: any) {
          //  @ts-ignore
          res(null);
        }
      });
    });

    request.on('error', (error) => {
      rej(`获取 changelog.json 失败:` + error.toString());
    });

    request.end();
  });
}

export function fetchRemotePkgJSON(remote_url: string): Promise<any> {
  return new Promise<Object>((res, rej) => {
    const request = net.request(`${remote_url}/package.json`);

    let data = "";

    request.on('response', (response) => {
      // 处理响应数据
      response.on('data', (chunk) => {
        data += chunk;
      });

      // 响应数据接收完毕
      response.on('end', () => {
        try {
          res(JSON.parse(data));
        } catch (e: any) {
          //  @ts-ignore
          res(null);
        }
      });
    });

    request.on('error', (error) => {
      rej(`自动更新检查请求失败:` + error.toString());
    });

    request.end();
  });
}
