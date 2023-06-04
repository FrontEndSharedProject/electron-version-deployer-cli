import { build } from "vite";

/** @type 'production' | 'development'' */
const mode = (process.env.MODE = process.env.MODE || "development");

const watch = mode === "development" ? {} : null;

function main() {
  //  types 构建
  build({
    mode,
    configFile: "./vite.config.js",
    build: {
      emptyOutDir: false,
      watch,
    },
  });

  //  cli 构建
  build({
    mode,
    configFile: "./vite.config.cli.js",
    build: {
      emptyOutDir: false,
      watch,
    },
  });

  //  main 构建
  build({
    mode,
    configFile: "./vite.config.main.js",
    build: {
      ssr: true,
      emptyOutDir: false,
      watch,
    },
  });
}

main();
