import { program } from "commander";
import { getConfigs } from "../helpers/getConfigs";
import { execSync } from "node:child_process";
import { r } from "../utils";
import logSymbols from "log-symbols";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { EVDConfigType } from "@/types/EVDConfigType";
import parseChangelog from "changelog-parser";
import { join, resolve } from "node:path";
import { marked } from "marked";
import { JSDOM } from "jsdom";
import DOMPurify from "dompurify";
import { archiveFiles } from "../helpers/archiveFiles";

program
  .command("prepare")
  .description(
    "部署前的准备工作，如获取编译软件获取逻辑代码，生成 changelog 等"
  )
  .action(async (source, destination) => {
    const configs = await getConfigs();

    try {
      await genTmpFolder();
      await compile(configs);
      //  生成日志需要放在编译后面，这样才能读取到准确的 pkg.version
      await genChangelog(configs);
      await copySourceAndZipFiles(configs);
    } catch (e: any) {
      console.log(logSymbols.error, e.toString());
    }

    console.log(logSymbols.info, "请执行 evd deploy 命令进行部署");
  });

async function copySourceAndZipFiles(configs: EVDConfigType) {
  const logicCodeZipPath = r("node_modules/.evd/logicCode.zip");
  //  including node_modules
  const fullCodeZipPath = r("node_modules/.evd/fullCode.zip");

  const nodeModulesPath = join(
    resolve(configs.sources.folder),
    configs.sources.nodeModules
  );
  const codesPath = join(
    resolve(configs.sources.folder),
    configs.sources.codes
  );
  const packageJSONPath = join(
    resolve(configs.sources.folder),
    configs.sources.packageJSON
  );

  //  判断文件是否存在
  if (!existsSync(nodeModulesPath)) {
    throw new Error(
      `${r(
        configs.sources.nodeModules
      )} 文件夹不存在，请检查 configs.sources.nodeModules 配置是否正确！`
    );
  }
  if (!existsSync(codesPath)) {
    throw new Error(
      `${r(
        configs.sources.codes
      )} 文件夹不存在，请检查 configs.sources.codes 配置是否正确！`
    );
  }
  if (!existsSync(packageJSONPath)) {
    throw new Error(
      `${r(
        configs.sources.packageJSON
      )} 文件夹不存在，请检查 configs.sources.packageJSON 配置是否正确！`
    );
  }

  //  生成压缩文件
  await archiveFiles(fullCodeZipPath, [
    nodeModulesPath,
    codesPath,
    packageJSONPath,
  ]);
  await archiveFiles(logicCodeZipPath, [codesPath, packageJSONPath]);

  //  将 package.json 放进去
  copyFileSync(packageJSONPath, r("node_modules/.evd/package.json"));

  //  note: cloudflare 需要去配置 cors
  //  https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/cors/

  //  写入 netlify.toml 文件
  writeFileSync(
    r("node_modules/.evd/netlify.toml"),
    `[[headers]]
  for = "/*"
    [headers.values]
    Access-Control-Allow-Origin = "*"
    Access-Control-Allow-Methods = "*"
    Access-Control-Allow-Headers = "*"`,
    "utf-8"
  );

  console.log(logSymbols.success, "更新包创建成功！");
}

async function genChangelog(configs: EVDConfigType) {
  if (!existsSync(r(configs.changelogsPath))) {
    throw new Error(`${r(configs.changelogsPath)} 文件不存在，请先创建！`);
  }

  const outputPackageJSONPath = join(
    resolve(configs.sources.folder),
    configs.sources.packageJSON
  );
  if (!existsSync(outputPackageJSONPath)) {
    throw new Error(
      `${outputPackageJSONPath} 文件不存在，请检查 sources.packageJSON 配置是否正确`
    );
  }
  const pkgContent = JSON.parse(readFileSync(outputPackageJSONPath, "utf-8"));
  const currentVersion = pkgContent.version;

  //  解析 changelogs
  //  https://www.npmjs.com/package/changelog-parser
  const changes = await parseChangelog({
    filePath: r(configs.changelogsPath),
    removeMarkdown: false,
  });

  const currentChange = changes.versions.find((change) => {
    return change.version === currentVersion;
  });

  if (!currentChange) {
    throw new Error(
      `无法在 ${configs.changelogsPath} 中找到当前版本 ${currentVersion} 的记录，请检查是否按正确格式编写 changelog！`
    );
  }

  const { date, version, title, body } = currentChange;

  if (body.trim().length === 0) {
    throw new Error(`当前版本 ${currentVersion} 的 Changelog 记录为空！`);
  }

  //  去除非法字符串
  const window = new JSDOM("").window;
  const purify = DOMPurify(window);
  const html = purify.sanitize(
    marked.parse(body, {
      mangle: false,
      headerIds: false,
    })
  );

  //  写入到 .evd/changelog.json 中
  writeFileSync(
    r("node_modules/.evd/changelog.json"),
    JSON.stringify({
      title,
      version,
      date,
      changes: html,
    }),
    "utf-8"
  );

  console.log(
    logSymbols.success,
    `写入 changelog.json 成功 ${r("node_modules/.evd/changelog.json")}`
  );
}

async function compile(configs: EVDConfigType) {
  console.log(logSymbols.info, "开始编译", r());
  execSync(`npm run ${configs.compileCommand}`, {
    stdio: "inherit",
    cwd: r(),
  });
  console.log(logSymbols.success, "编译成功！");

  //  判断资源文件夹是否存在
  if (!existsSync(configs.sources.folder)) {
    throw new Error(
      `无法找到资源目录, ${configs.sources.folder} 请检查配置是否正确！`
    );
  }
}

function genTmpFolder() {
  const folderPath = r("node_modules/.evd");
  if (!existsSync(folderPath)) mkdirSync(folderPath);
}
