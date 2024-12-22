import { netRequest } from "./netRequest";

export function fetchRemoteChangelogJSON(remote_url: string): Promise<any> {
  return netRequest({
    url: `${remote_url}/changelog.json`,
    responseType: 'json'
  }).catch(error => {
    throw new Error(`获取 changelog.json 失败: ${error}`);
  });
}

export function fetchRemotePkgJSON(remote_url: string): Promise<any> {
  return netRequest({
    url: `${remote_url}/package.json`,
    responseType: 'json'
  }).catch(error => {
    throw new Error(`自动更新检查请求失败: ${error}`);
  });
}
