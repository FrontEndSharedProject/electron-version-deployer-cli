import { sync as PkgUpSync } from "pkg-up";
import { resolve, join, dirname } from "node:path";

const pkgPath = PkgUpSync();

export function r(...paths: string[]) {
  const currentPkgPath = PkgUpSync({ cwd: process.cwd() }) || pkgPath;
  if (!currentPkgPath) return "./";
  if (paths.length === 0) return dirname(resolve(currentPkgPath));
  return join(dirname(resolve(currentPkgPath)), ...paths);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return bytes + " B";
  } else if (bytes < 1048576) {
    return (bytes / 1024).toFixed(2) + " KB";
  } else {
    return (bytes / 1048576).toFixed(2) + " MB";
  }
}
