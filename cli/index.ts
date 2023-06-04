import { program } from "commander";
import "./commands/init";
import "./commands/prepare";
import "./commands/deploy";
import "./commands/install-prebuilt";

program
  .description(
    "Electron 版本部署 CLI，简化你的 Electron 软件更新，让一切变得简单。"
  )
  .helpOption("-h, --help", "使用帮助")
  .version(import.meta.env.PKG_VERSION, "-V, --version", "显示版本号")
  .parse(process.argv);
