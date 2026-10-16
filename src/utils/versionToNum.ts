export const STRICT_VERSION_RE = /^\d+\.\d+\.\d+$/;

//  计算版本号大小,转化大小
export function versionToNum(a: string) {
  return String(a)
    .trim()
    .split(".")
    .map((segment) => segment.padStart(16, "0"))
    .join("");
}
