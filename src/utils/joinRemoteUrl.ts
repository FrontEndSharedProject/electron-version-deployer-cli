/**
 * 拼接远程地址，兼容 remoteUrl 带尾斜杠以及子目录形式的地址
 * 如 https://cdn.example.com/app/my-project/
 */
export function joinRemoteUrl(base: string, path: string) {
  return `${(base ?? "").replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
