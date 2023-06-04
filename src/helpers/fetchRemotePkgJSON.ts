import { get } from "node:https";

export function fetchRemoteChangelogJSON(remote_url: string): Promise<any> {
  return new Promise<Object>((res, rej) => {
    get(`${remote_url}/changelog.json`, (_res) => {
      let data = "";

      // 处理响应数据
      _res.on("data", (chunk) => {
        data += chunk;
      });

      // 响应数据接收完毕
      _res.on("end", () => {
        try {
          res(JSON.parse(data));
        } catch (e: any) {
          //  @ts-ignore
          res(null);
        }
      });
    }).on("error", (err) => {
      rej(`获取 changelog.json 失败:` + err.toString());
    });
  });
}

export function fetchRemotePkgJSON(remote_url: string): Promise<any> {
  return new Promise<Object>((res, rej) => {
    get(`${remote_url}/package.json`, (_res) => {
      let data = "";

      // 处理响应数据
      _res.on("data", (chunk) => {
        data += chunk;
      });

      // 响应数据接收完毕
      _res.on("end", () => {
        try {
          res(JSON.parse(data));
        } catch (e: any) {
          //  @ts-ignore
          res(null);
        }
      });
    }).on("error", (err) => {
      rej(`自动更新检查请求失败:` + err.toString());
    });
  });
}
