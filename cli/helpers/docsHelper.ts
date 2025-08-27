import fs from "fs";
import path from "path";
import os from "os";

/** 统计换行符（用于日志/调试） */
function countLineEndings(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const noCRLF = text.replace(/\r\n/g, "");
  const lf = (noCRLF.match(/\n/g) || []).length;
  const cr = (noCRLF.match(/\r/g) || []).length;
  return { crlf, lf, cr };
}

/**
 * 将文本换行统一为当前系统的 os.EOL
 * @param {string} text
 * @param {Object} opts
 * @param {boolean} [opts.stripBOM=true]            是否移除 UTF-8 BOM
 * @param {boolean} [opts.ensureFinalNewline=false] 是否保证文件末尾存在换行
 */
function normalizeToOSEOL(
  text: string,
  opts: { stripBOM?: boolean; ensureFinalNewline?: boolean } = {}
) {
  const { stripBOM = true, ensureFinalNewline = false } = opts;

  // 可选：去除 UTF-8 BOM（\uFEFF）
  if (stripBOM && text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const target = os.EOL; // 当前系统换行符（Windows 为 \r\n，类 Unix 为 \n）
  const before = text;
  let normalized = text.replace(/\r\n|\r|\n/g, target);

  if (
    ensureFinalNewline &&
    normalized.length > 0 &&
    !normalized.endsWith(target)
  ) {
    normalized += target;
  }

  const changed = normalized !== before;
  return {
    text: normalized,
    changed,
    stats: countLineEndings(before),
    target: target === "\r\n" ? "crlf" : target === "\r" ? "cr" : "lf",
  };
}

/** 文件版：读取 → 统一到 os.EOL →（可选）写回 */
function normalizeFileToOSEOL(filePath: string, opts = {}, encoding = "utf8") {
  const raw = fs.readFileSync(filePath, {
    encoding: encoding as BufferEncoding,
  });
  const result = normalizeToOSEOL(raw, opts);
  if (result.changed)
    fs.writeFileSync(filePath, result.text, { encoding: "utf8" });
  return { file: filePath, ...result };
}

/** 目录版：递归处理指定后缀文本文件 */
function normalizeDirToOSEOL(dir: string, exts: string[] = [], opts = {}) {
  const out: {
    file: string;
    changed: boolean;
    stats: { crlf: number; lf: number; cr: number };
    target: string;
  }[] = [];
  (function walk(p) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    } else {
      if (!exts.length || exts.includes(path.extname(p).toLowerCase())) {
        out.push(normalizeFileToOSEOL(p, opts));
      }
    }
  })(dir);
  return out;
}

export { normalizeToOSEOL, normalizeFileToOSEOL, normalizeDirToOSEOL };
