# electron-version-deployer-cli

electron 版本版本更新命令行

# 目的

1. 减少每次版本更新包的大小，最理想的情况是每次只更新修改的代码，而不是整个软件.
2. 快速更新而不需要经过任何商店审核

# 实现原理

[部署流程](https://mermaid.live/edit#pako:eNqdkd1KAkEYhm9lmCMj8wI8CMJfoqM63JUYdsfV3B9ZdwtxBaMiJSHEsKigoiBPRJGQhU27md3Z9S4aG4WNPGqO5vned96Z75saFDQRwzjMy9qJUEC6Afb2eRXQtcP5n71g2AmmQ9eZ5MDW1jZI1Eir67UvXOfVfz6tM2NiIVlMmDecYNZhsgWSXMS1neDrwe9fbRJ7TJ66DMI2nlfLSCghCceOKpq6kfubSloN8thapab-kUpRpY0eKppoyrjy-5Jg6HjXvUQBqRKWNckCaS4irGjNo5gfhPMtkOEi69pI_swty3mDO3Iz85oj1_4gtxP__hzE8LEISO-STte1B0t_ivkZpMOQCUN2OZ334KU9P-v707HXmbrOmwV2uSU3R0DFhlzMV2k0OwWjUMG6gooi_fHaosZDo4AVzMM43YpIL_GQV-vUh0xDO6iqAowbuomj0CyLyMDJIpJ0pLBi_Run1P63)

[检测更新流程](https://mermaid.live/edit#pako:eNp1kstO6zAQhl9l5C2UB8iim7Bmk202VuIWQ5rkJM4CEBJCXEIJt6MedKAVFSAu4tYiIVEQFS-TccqKV8BRqSASeGXN_8381j9eIJZnM6KRkP2JmGuxSU6rAa2Zrk8DwS3uU1eADjQEvDuR8WN23SlqRq7J1hbWj_Hg0nRBHb1ULo_pGgzWr7B-KZsPcr8rT5dk--ybbii98yjvl8Gn1iytsomZ0HOHgFEqlUv5gNcGNo9-AHQF5A7YeZKdhmzdYKuLfxOYYsLhlTlIe_VCF2QbsaKywxVMnjG-fn9J0t7moN9Pe1u4m6g6zHMfMFkdzp_yBIOAV6cFeBXIjc6X5VGrODPt3eaNNvOZa6vwOFMp7exljXb6vIY7_zHZx-790AcqkeMYfJ5NKJ_fPHbPMT745B2vyi1dLSf86hjl9okUXmwo7VtkBW2U1uDiFLc3Me4C9X3ImnfY__dF5N1v6yoOteFhlYyTGgtqlNvqhyzkNZOIaVZjJtHU1abBrElMd1FxNBKeMedaRBNBxMZJ5NtUjH4T0SrUCdniB57VDHA)

# 安装

首先在你项目的根目录（与 package.json 同级）运行

```shell
$ npm install electron-version-deployer-cli
```

注意 ⚠️，我们需要将它安装在 `dependencies` 下，因此请不要添加额外参数。

# 使用

## 添加依赖包

添加一下包到你的 `devDependencies` 中

> 添加后，可能会有些包出现重复，手动删下就行了（编译器会有提示）

```json
{
  "electron": ">=10.0.0",
  "@inquirer/prompts": "^1.2.3",
  "changelog-parser": "^3.0.1",
  "commander": "^10.0.1",
  "dompurify": "^3.0.3",
  "download": "^8.0.0",
  "esno": "^0.16.3",
  "jsdom": "^22.1.0",
  "log-symbols": "=4.1.0",
  "marked": "^5.0.4",
  "netlify-cli": "^15.2.0",
  "vite": "^4.3.9"
}
```

> 由于我们需要在主进程里面调用 `electron-version-deployer-cli` 的检测自动更新逻辑，如果把依赖的包都放到 `dependencies`, 那么你的软件编译后也会附带这些依赖包，这是完全没有必要的。因此需要手动添加下

## 使用

### 主进程添加自动更新检测

在你的主进程中，添加以下代码, 来实现更新检测

```typescript
// main.js
import { EVDInit } from "electron-version-deployer-cli/dist/main";

EVDInit({
  netlifyUrl: import.meta.env.REMOTE_URL,
  logo: `file://${join(
    app.getAppPath(),
    "packages",
    "main",
    "dist",
    "icon.png"
  )}`,
  onError(error) {
    //  记录更新检测遇到的错误
    writeError(error, "evd");
  },
  onBeforeNewPkgInstall(next) {
    //  window 下如果某些程序正在使用 node_modules 会导致
    //  Error: EBUSY: resource busy or locked 错误

    //  因此在安装前, 你可以手动关闭这些程序
    DB.close();

    //  执行 next 方法，继续安装
    next();
  },
});
```

EVDInit 方法接受的参数如下

```typescript
type EVDInitPropsType = {
  //  检测远程更新的地址
  netlifyUrl: string;

  //  弹窗宽度
  windowWidth?: number;
  //  弹窗高度
  windowHeight?: number;
  //  logo 图标
  logo?: string;
  //  检测频率/s
  detectionFrequency?: number;
  //  是否在程序开始运行时进行检测
  detectAtStart?: boolean;
  //  当自动更新出现错误时的回掉
  onError?: (err: unknown) => void;
  onBeforeNewPkgInstall?: (next: () => any) => void;
};
```

> 一下命令全部必须在项目根目录执行 （与 package.json 同级）

### 初始化配置

```shell
# 进入命令行交互模式
$ evd init

# 直接生成配置，与 npm init -y 行为类似
$ evd init -y
```

该命令主要是生成一个 evd.config.js 的配置文件。

> ⚠️ 如果你根目录下已经有了这个文件，就不需要再执行了

## 配置项

> 如果你用 typescript 是有完全的提示的

```typescript
export type PrebuiltConfigType = Record<
  string,
  { files: string[]; outputPath: string[] }
>;

export type EVDConfigType = {
  //  编译命令, 如 pack-mac
  //  在部署前，需要从编译后的软件里面，获取逻辑代码
  compileCommand: string;
  //  CHANGELOG.md 文件位置，用于读取显示给用户此次版本更新的内容
  changelogsPath: string;
  //  编译后的源文件位置
  sources: {
    //  源文件目录, 编译后的 软件名称.app/Contents/Resources/app 文件夹
    folder: string;
    //  node_modules 路径（相对 folder）
    nodeModules: string;
    //  逻辑代码路径（相对 folder）
    codes: string;
    //  package.json 文件路径（相对 folder）
    packageJSON: string;
  };
  //  netlify 部署设置
  netlify: {
    //  网站域名如 https://site.netlify.app
    url: string;
    token: string;
    siteID: string;
  };
  prebuiltConfig: PrebuiltConfigType;
};
```

## 更新版本

如果你要更新一个版本，需要执行一下两个步骤

### 编译

```shell
$ evd prepare
```

这个命令首先对软件进行编译，然后将一些代码和 changelog 放到 .evd 文件夹中

### 部署

```shell
$ evd deploy
```

这个命令主要是把 .evd 文件夹部署到 netlity 上，并且对远程版本号，和当前版本号进行多方面的判断，尽量避免误操作问题

### 手动检查版本更新

如果你想要通过 **编程** 的方式，检测版本更新，可以使用 `EVDCheckUpdate` 这个方法

```typescript
//  main.ts
import { EVDCheckUpdate } from "electron-version-deployer-cli/dist/main";

//  如果有新版本，isHaveNewVersion 返回的就是 false，否则是 true
//  如果有新版本，它会自动打开更新框
EVDCheckUpdate().then((isHaveNewVersion: boolean) => {
  if (!isHaveNewVersion) {
    IPC.send("showMessage", "success", "当前已是最新版本！");
  }
});
```

## 安装预构建

某些依赖包需要预构建才能在不同平台上执行，比如 sqlite3，这样才能保证用户更新 node_modules 不会出现预构建找不到而导致的报错问题

比如我们要配置 sqlite3 的预构建
只需要添加 `configs.prebuiltConfig` 即可

```json
{
  "prebuiltConfig": {
    "sqlite3": {
      "files": [
        "napi-v6-darwin-unknown-arm64.tar.gz",
        "napi-v6-darwin-unknown-x64.tar.gz",
        "napi-v6-win32-unknown-x64.tar.gz"
      ],
      "outputPath": ["lib", "binding"]
    }
  }
}
```

其中 files 是你需要安装的 prebuilt 版本。 outputPath 是你需要将这些与构建版本放到 sqlite3 的那个目录下，上面的配置会把这些预构建的 `.gz` 文件放到 `node_modules/sqlite3/lib/binding` 目录下面去

配置完后，只需要执行以下命令，他就会自动安装了

```shell
evd install-prebuilt
```
