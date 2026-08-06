# electron-version-deployer-cli

electron 版本版本更新命令行

> **0.5.0 已发布** — 新增自建服务器部署（`evd preDeploy` / `evd verify`）与更新错误类型化（`EVDError`）。
> 升级前请看 [0.5.0 版本说明与升级指南](#050-版本说明与升级指南)。**无破坏性变更，直接升级即可。**

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
  "@inquirer/prompts": "^1.2.3",
  "changelog-parser": "^3.0.1",
  "commander": "^10.0.1",
  "dompurify": "^3.0.3",
  "download": "^8.0.0",
  "electron": ">=10.0.0",
  "esno": "^0.16.3",
  "jsdom": "^22.1.0",
  "log-symbols": "=4.1.0",
  "marked": "^5.0.4",
  "netlify-cli": "^15.2.0",
  "vite": "^4.3.9",
  "wrangler": "^3.3.0"
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
  remoteUrl: import.meta.env.REMOTE_URL,
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
  onBeforeNewPkgInstall(next, version:string) {
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
  //  检测远程更新的地址，支持子目录，如 https://cdn.mycorp.com/app/my-project
  remoteUrl: string;

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
  //  检测更新的请求超时时间/ms，默认 10000
  requestTimeout?: number;
  //  下载更新包的停顿超时时间/ms，连续该时长没有新数据才算超时，默认 60000
  downloadStallTimeout?: number;
  //  当自动更新出现错误时的回掉，回调参数为 EVDError
  onError?: (err: unknown) => void;
  onBeforeNewPkgInstall?: (next: () => any) => void;
};
```

`remoteUrl` **支持子目录形式**（如 `https://plugin.example.com/app/simple-marker-local`），末尾带不带 `/` 都可以。

## 更新错误处理

`onError` 收到的是 `EVDError`，可以按 `code` 分别提示。比如远程域名需要 VPN，用户没连时会拿到 `NETWORK_TIMEOUT`：

```typescript
import {
  EVDInit,
  EVDErrorCodeEnum,
  isEVDError,
  formatEVDErrorDetail,
} from "electron-version-deployer-cli/dist/main";

EVDInit({
  remoteUrl: import.meta.env.REMOTE_URL,
  onError(error) {
    if (!isEVDError(error)) return writeError(error, "evd");

    switch (error.code) {
      case EVDErrorCodeEnum.NETWORK_TIMEOUT:
      case EVDErrorCodeEnum.NETWORK_UNREACHABLE:
        //  连不上，多半是没连 VPN
        showTip("无法连接更新服务器，请先连接 VPN");
        break;
      case EVDErrorCodeEnum.REMOTE_NOT_FOUND:
        writeError(`${error.url} 上还没有发布过版本`, "evd");
        break;
      default:
        //  可直接复制给开发者排查的完整信息
        writeError(formatEVDErrorDetail(error), "evd");
    }
  },
});
```

`EVDError` 字段：

| 字段 | 说明 |
| --- | --- |
| `code` | `EVDErrorCodeEnum`，见下表 |
| `phase` | `check`（后台检测）/ `download`（下载更新包）/ `install`（解压安装） |
| `url` | 出错的远程地址 |
| `statusCode` | HTTP 状态码（有的话） |
| `cause` | 原始错误对象 |

错误码：

| code | 含义 |
| --- | --- |
| `NETWORK_TIMEOUT` | 请求超时，常见于需要 VPN 才能访问的域名 |
| `NETWORK_UNREACHABLE` | DNS 解析失败 / 连接被拒绝 / 断网 |
| `SSL_ERROR` | 证书校验失败，自建服务器用自签名证书时常见 |
| `HTTP_ERROR` | 非 2xx 响应 |
| `REMOTE_NOT_FOUND` | 404，远程未部署过或地址填错 |
| `REMOTE_INVALID_JSON` | 有响应但不是合法 JSON，静态服务器返回兜底页时常见 |
| `DOWNLOAD_TIMEOUT` | 下载过程中长时间没有新数据 |
| `DOWNLOAD_FAILED` | 下载中断 |
| `UNZIP_FAILED` | 更新包解压失败 |
| `INSTALL_FAILED` | 文件复制安装失败 |
| `NOT_INITIALIZED` | 未先调用 `EVDInit` |
| `UNKNOWN` | 其它，原始错误在 `cause` 里 |

内置文案表 `EVD_ERROR_MESSAGES` 也可以直接拿来用（`EVD_ERROR_MESSAGES[error.code]`）。

### 更新弹窗内的错误提示

用户点「现在更新」后如果下载或安装失败，弹窗会自动显示错误面板：错误文案、错误码、可滚动的完整详情，以及「重试」「复制错误信息」「关闭」三个按钮。「复制错误信息」会把时间、平台、阶段、错误码、地址、状态码、原始错误与堆栈一并写入剪贴板，方便用户直接发给开发者排查。

> 一下命令全部必须在项目根目录执行 （与 package.json 同级）

### 初始化配置

```shell
# 进入命令行交互模式
$ evd init
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
  //  额外需要打包的文件夹
  //  这将会在部署时将文件夹里面的内容，一同部署到服务器上
  //  文件会被放在根目录的 basename 文件中，比如
  // 传入 ['public/test'] 这样一个文件夹，那么最终会被放到根目录的
  // /test 中
  // 注意:当个文件不能超过 25mb 这是 cloudflare 的限制（仅 cloudflare 适用）
  // 注意：必须使用相对路径，相对路径谁相对于 evd.config.ts 文件
  extraFolders: string[] | (() => Promise<string[]>) | (() => string[]);
  //  netlify 部署设置
  netlify?: {
    //  网站域名如 https://site.netlify.app
    url: string;
    token: string;
    siteID: string;
  };
  cloudflare?: {
    url: string;
    token: string;
    projectName: string;
  };
  //  自托管服务器设置
  //  由 CI 自行上传 node_modules/.evd 目录，evd 只负责检测
  selfHosted?: {
    //  更新包最终可访问的地址，如 https://cdn.mycorp.com/app
    url: string;
  };
  //  fullCode.zip 拆分设置
  zipSplit?: {
    //  是否拆分，默认按 provider 推断：cloudflare 为 true，netlify / selfHosted 为 false
    enabled?: boolean;
    //  超过该体积（MB）才拆分，默认 24
    thresholdMB?: number;
    //  每片体积（MB），默认 20
    chunkSizeMB?: number;
  };
  prebuiltConfig: PrebuiltConfigType;
};
```

三个 provider 按 `netlify` → `cloudflare` → `selfHosted` 的顺序自动探测，配置齐全的第一个生效。

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

## 部署到自建服务器（CI）

如果更新包不是通过 API 部署，而是由 CI 命令（rsync / scp / 内网发布脚本）传到自己的服务器上，用 `preDeploy` + `verify` 这一对命令。

### 配置

```typescript
selfHosted: {
  url: "https://cdn.mycorp.com/app",
},
```

`selfHosted` 模式下执行 `evd deploy` 会直接报错，部署动作由你自己的 CI 完成。

### evd preDeploy

```shell
$ evd preDeploy
```

跑完 `deploy` 里的全部检测，并把 `extraFolders` 复制进 `.evd`、按配置整形压缩包，通过后 `node_modules/.evd` 就是可以直接上传的内容。

**全程无交互**，命中风险项直接报错并 `exit 1`，需要显式加参数放行：

| 参数 | 放行的情况 |
| --- | --- |
| `--allow-first-deploy` | 远程尚未部署过任何版本（远程 `package.json` 取不到） |
| `--allow-name-mismatch` | 本地与远程 `package.json` 的 `name` 不一致 |
| `--allow-same-version` | 远程版本与本地一致（覆盖部署） |
| `--allow-downgrade` | 远程版本高于本地 |
| `--force` | 等价于上面全开 |
| `--split` / `--no-split` | 覆盖 `configs.zipSplit.enabled` |
| `--timeout <ms>` | 远程请求超时，默认 `10000` |

注意：远程地址**连不上**（DNS 失败、连接被拒、超时）一律报错，`--allow-first-deploy` 也不放行——这正是要暴露的链接问题。

### evd verify

```shell
$ evd verify
```

上传完成后执行，校验远程链接真的生效：远程 `package.json` 的 `name` / `version` 与本地一致、`changelog.json`、`changelogs.html`、`logicCode.zip`、`fullCode.zip`（或全部分片）均可访问。任一项不通过即 `exit 1`。

请求全部带 cache-buster，可用 `--retry <n>`、`--retry-delay <s>` 应对 CDN 传播延迟。`--retry` 是**总尝试次数（含首次）**，默认 3 表示最多校验 3 次；`--retry-delay` 是两次尝试之间的间隔秒数，默认 5。

### GitLab CI 示例

```yaml
deploy:
  script:
    - npx evd prepare
    - npx evd preDeploy
    - rsync -av --delete node_modules/.evd/ "$DEPLOY_TARGET"
    - npx evd verify
```

### 关于压缩包拆分

`fullCode.zip` 超过 25MB 会被 Cloudflare Pages 拒绝，因此 cloudflare 下默认拆分成多个分片 + 一个 `fullCodeZipSplitZips/index.json` 描述文件，客户端会自动识别并合并下载。

自建服务器没有这个限制，`selfHosted` 与 `netlify` 默认**不拆分**。需要时用 `configs.zipSplit` 或 `--split` 打开。

> 关掉拆分时，`.evd` 里遗留的 `fullCodeZipSplitZips` 目录会被自动清理——否则它会被一起传上去，客户端读到旧的 `index.json` 就会去下载并不存在的分片。

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

## 0.5.0 版本说明与升级指南

### 一句话总结

**没有破坏性变更**，从 0.4.x 直接升到 0.5.0 即可，现有配置和代码都不用改。新功能全部是可选的。

```shell
$ npm install electron-version-deployer-cli@0.5.0
```

### 新功能

#### 1. 部署到自建服务器：`evd preDeploy` + `evd verify`

0.4.x 只支持 Netlify / Cloudflare 两个 API 型部署目标。如果你的更新包是用自己的 CI 命令（rsync / scp / 内网脚本）传到自己服务器上的，以前只能执行 `evd prepare` 然后手动上传，**`evd deploy` 里的全部检测逻辑都被跳过**——版本号是否倒退、项目名是否对得上、远程有没有部署过，一个都不会检查。

现在配上 `selfHosted` 就能用这一对命令补齐：

```typescript
//  evd.config.js
selfHosted: {
  url: "https://cdn.mycorp.com/app",
},
```

```yaml
# .gitlab-ci.yml
deploy:
  script:
    - npx evd prepare
    - npx evd preDeploy            # 检测 + extraFolders + 打包整形
    - rsync -av --delete node_modules/.evd/ "$DEPLOY_TARGET"
    - npx evd verify               # 确认远程真的生效
```

`preDeploy` 全程无交互，命中风险项直接 `exit 1`，适合 CI；`verify` 在上传后校验远程版本与各更新包可达。详见[部署到自建服务器（CI）](#部署到自建服务器ci)。

#### 2. 更新错误类型化：`EVDError`

0.4.x 里 `onError` 拿到的是被拼成字符串的普通 `Error`，没法区分「超时」「域名解析不了」「远程压根没部署」。最典型的场景是更新地址需要挂 VPN，用户没连时软件会一直静默超时，界面上什么都不显示。

现在可以按 `code` 分别提示：

```typescript
import { EVDErrorCodeEnum, isEVDError } from "electron-version-deployer-cli/dist/main";

onError(error) {
  if (isEVDError(error) && error.code === EVDErrorCodeEnum.NETWORK_TIMEOUT) {
    showTip("无法连接更新服务器，请先连接 VPN");
  }
}
```

详见[更新错误处理](#更新错误处理)。

#### 3. 更新弹窗的失败提示

下载或安装失败时，弹窗会显示错误面板（文案 + 错误码 + 完整详情 + 「重试」「复制错误信息」「关闭」），不再永久卡在「软件更新中……」。「复制错误信息」把时间、平台、阶段、错误码、地址、状态码、原始错误与堆栈一并写入剪贴板，用户可以直接发给你排查。

#### 4. 压缩包拆分可配

`zipSplit` 可以控制 `fullCode.zip` 是否拆分。Cloudflare 因为 25MB 单文件限制默认拆分，自建服务器与 Netlify 默认不拆分。

### 升级需要注意什么

#### 必看：`evd prepare` / `evd deploy` 现在会返回非 0 退出码

0.4.x 里这两个命令失败时只打印错误、退出码仍是 0，**CI 里编译失败也会显示为成功**。0.5.0 修正为失败时 `exit 1`。

> ⚠️ 如果你的 CI 之前"一直是绿的"，升级后可能会开始变红。这不是新问题，是一直存在的失败终于被暴露出来了。升级后第一次跑 CI 请留意。

#### 检测更新的请求超时从 5 秒改为 10 秒

写死的 5 秒对需要走 VPN / 跨境的地址偏短。如果你希望保持原来的行为：

```typescript
EVDInit({ remoteUrl, requestTimeout: 5000 });
```

#### `onError` 收到的对象变了（但兼容）

回调签名 `(err: unknown) => void` 没变，`err.toString()` 和写日志的代码继续可用。只是现在传进来的是 `EVDError` 实例，多了 `code` / `phase` / `url` / `statusCode` / `cause` 字段可用。**不做任何改动也能正常工作。**

#### 更新弹窗模板的兼容性

新的错误面板依赖内置模板。运行时会优先加载 `node_modules/electron-version-deployer-cli/dist/templates/newVersionDialog.html`，你的软件更新到 0.5.0 后自然会用上新模板。老版本客户端收不到新增的 `evd-update-error` 事件也不会报错，行为与升级前一致。

### 迁移步骤

大多数项目只需要第 1 步。

**1. 升级依赖（必做）**

```shell
$ npm install electron-version-deployer-cli@0.5.0
```

到这里就结束了——所有 0.4.x 的配置和调用方式都继续有效。

**2. 想要按类型提示更新错误（可选）**

在主进程的 `EVDInit` 里补 `onError` 分支，参考上面「更新错误类型化」一节。

**3. 想要部署到自建服务器（可选）**

在 `evd.config.js` 里加 `selfHosted`，CI 脚本改成 `prepare` → `preDeploy` → 上传 → `verify`。

> ⚠️ 注意：如果你以前是"只跑 `evd prepare` 然后手动上传"，并且配置了 `extraFolders`，那么**这些文件夹此前一直没有被上传**（`extraFolders` 的复制只在 `evd deploy` 里执行）。0.5.0 把它移进了共享检测流程，`preDeploy` 也会执行。换句话说，改用 `preDeploy` 之后你的更新包里会多出这些文件夹——这是修复，不是回归。

**4. 自建服务器想关掉压缩包拆分（可选）**

自建服务器没有 Cloudflare 的 25MB 限制，`selfHosted` 下默认就不拆分，通常不用配。需要显式控制时：

```typescript
zipSplit: {
  enabled: false,
  thresholdMB: 24,
  chunkSizeMB: 20,
},
```

> 从拆分切到不拆分时，`.evd` 里遗留的 `fullCodeZipSplitZips` 目录会被自动清理。如果不清理，它会被一起传上去，客户端读到旧的分片描述文件后会去下载并不存在的分片。

### 其它修复

- 下载更新包增加了超时保护（此前连接挂起会永久卡住），采用停顿超时，慢速网络下载大包不会被误杀
- 下载会校验 HTTP 状态码（此前 404 返回的 HTML 页会被原样写进 zip，随后抛出难以理解的解压错误）
- 修复下载失败时软件仍然会重启的问题
- 修复分片下载失败后没有中断、仍继续下载剩余分片的问题
- 修复安装子进程失败时主进程当作成功处理的问题
- `remoteUrl` 带尾斜杠不再拼出 `//package.json`（部分 CDN 与对象存储会直接 404）
- **`remoteUrl` 支持子目录形式的地址**，如 `https://cdn.example.com/app/my-project`

完整清单见 [CHANGELOG.md](./CHANGELOG.md)。

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
