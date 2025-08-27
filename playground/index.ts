import parseChangelog from "changelog-parser";
import { normalizeToOSEOL } from "cli/helpers/docsHelper";
import { readFileSync } from "node:fs";

//  解析 changelogs
//  https://www.npmjs.com/package/changelog-parser
const text = readFileSync("./CHANGELOG.md", "utf-8");
const res = parseChangelog({
  text: normalizeToOSEOL(text, {
    stripBOM: true,
    ensureFinalNewline: true,
  }).text,
  removeMarkdown: false,
}).then(console.log);
