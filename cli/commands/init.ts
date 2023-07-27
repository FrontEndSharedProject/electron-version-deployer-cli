import { program } from "commander";
import { sync as PkgUpSync } from "pkg-up";
import { readFileSync, writeFileSync } from "node:fs";
import logSymbols from "log-symbols";
import { EVDConfigType } from "@/types/EVDConfigType";
import { join, resolve } from "node:path";
import { r } from "../utils";
import { CLI_NAME, CONFIG_FILE_NAME } from "@/const";

program
  .command("init")
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
      cloudflare: {
        url: "",
        token: "",
        projectName: "",
      },
      prebuiltConfig: {},
    };

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
