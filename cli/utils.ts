import { sync as PkgUpSync } from "pkg-up";
import { resolve, join, dirname } from "node:path";

const pkgPath = PkgUpSync();

export function r(...paths: string[]) {
  if (!pkgPath) return "./";
  if (paths.length === 0) return dirname(resolve(pkgPath));
  return join(dirname(resolve(pkgPath)), ...paths);
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
