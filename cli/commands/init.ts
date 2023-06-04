import { program } from "commander";
import { sync as PkgUpSync } from "pkg-up";
import { readFileSync, writeFileSync } from "node:fs";
import logSymbols from "log-symbols";
import { EVDConfigType } from "@/types/EVDConfigType";
import { input } from "@inquirer/prompts";
import { join, resolve } from "node:path";
import { r } from "../utils";
import { CLI_NAME, CONFIG_FILE_NAME } from "@/const";

program
  .command("init")
  .option("-y", "自动确认初始化", false)
  .description("生成配置文件")
  .action(async (source, destination) => {
    const pkgPath = PkgUpSync();
    if (!pkgPath)
      return console.log(
        logSymbols.error,
        "当前 cwd 下找不到 package.json 文件 \n 请确保该命令在 node 项目中执行！"
      );

    const pkgContent = JSON.parse(readFileSync(pkgPath, "utf-8")) as any;

    //  定义默认配置
    const name = pkgContent.name.split("/").pop().replaceAll("-", "");
    const defaultConfig: EVDConfigType = {
      compileCommand: "compile:mac",
      changelogsPath: "CHANGELOG.md",
      sources: {
        folder: `dist/mac-arm64/${name}.app/Resources/app`,
        nodeModules: "node_modules",
        codes: "build",
        packageJSON: "package.json",
      },
      netlify: {
        url: "",
        token: "",
        siteID: "",
      },
      prebuiltConfig: {},
    };

    //  手动生成
    if (!source.y) {
      defaultConfig.compileCommand = await input({
        message: "请输入编译命令",
        default: defaultConfig.compileCommand,
        // validate(str) {
        //   const scripts = pkgContent.scripts ?? {};
        //   return Promise.resolve(
        //     scripts[str] ? true : `无法在 package.json 中找到该命令！`
        //   );
        // },
      });

      defaultConfig.changelogsPath = await input({
        message: "请输入 changelogs 文件位置（以项目根目录为准的相对路径)",
        default: defaultConfig.changelogsPath,
        // validate(str) {
        //   return Promise.resolve(
        //     existsSync(r(str))
        //       ? /\.md$/.test(str)
        //         ? true
        //         : "该文件必须是以 .md 结尾的 Markdown 文件"
        //       : "该文件不存在！"
        //   );
        // },
      });

      defaultConfig.sources.folder = await input({
        message: "请输入源文件目录",
        default: `dist/mac-arm64/myapp.app/Resources/app`,
      });

      defaultConfig.sources.nodeModules = await input({
        message: "请输入源文件 node_modules 目录",
        default: defaultConfig.sources.nodeModules,
      });

      defaultConfig.sources.codes = await input({
        message: "请输入源文件 逻辑代码目录",
        default: defaultConfig.sources.codes,
      });

      defaultConfig.sources.packageJSON = await input({
        message: "请输入源文件 package.json 路径",
        default: defaultConfig.sources.packageJSON,
      });

      defaultConfig.netlify.url = await input({
        message: "请输入 Netlify 网站域名",
      });

      defaultConfig.netlify.token = await input({
        message: "请输入 Netlify Token",
      });

      defaultConfig.netlify.siteID = await input({
        message: "请输入 Netlify SiteID",
      });
    }

    let evdConfigContent = readFileSync(
      join(resolve(__dirname), "templates", "evd.config.ts"),
      "utf-8"
    );

    //  配置文件内容处理
    evdConfigContent = evdConfigContent.replace(/\/\/\s+@ts-nocheck\n/, "");
    evdConfigContent = evdConfigContent.replace(/"@\/index"/, `"${CLI_NAME}"`);

    //  替换内容
    Object.entries(defaultConfig).map(([key, value]) => {
      if (typeof value === "object") {
        Object.entries(value).map(([_key, _value]) => {
          evdConfigContent = evdConfigContent.replace(
            new RegExp(`__${key}_${_key}__`),
            `"${_value}"`
          );
        });
      } else {
        evdConfigContent = evdConfigContent.replace(
          new RegExp(`__${key}__`),
          `"${value}"`
        );
      }
    });

    writeFileSync(r(CONFIG_FILE_NAME), evdConfigContent, "utf-8");
    console.log(
      logSymbols.success,
      `生成配置文件 ${r(CONFIG_FILE_NAME)} 成功!`
    );
  });
