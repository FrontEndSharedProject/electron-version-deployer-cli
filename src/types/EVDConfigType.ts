/**
 * 需要安装 prebuilt 的配置
 * @example
 *  {
 *   sqlite3: {
 *     files: [
 *       'napi-v6-darwin-unknown-arm64.tar.gz',
 *       'napi-v6-darwin-unknown-x64.tar.gz',
 *       'napi-v6-win32-unknown-x64.tar.gz',
 *     ],
 *     //  相对于 sqlite3 这个包的存放位置
 *     outputPath: ['lib', 'binding'],
 *    }
 *   }
 */
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
  //  在打包准备阶段将目录打入 fullCode.zip 与 logicCode.zip 根层级的 <basename> 目录中，
  //  客户端执行热更新解压后递归覆盖写入本地 app.getAppPath()/<basename>（支持相对项目根目录路径或绝对路径）
  extraFolders?: string[] | (() => Promise<string[]>) | (() => string[]);
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
  //  更新压缩包（fullCode.zip / logicCode.zip）拆分设置
  zipSplit?: {
    //  是否拆分，默认按 provider 推断：cloudflare 为 true，netlify / selfHosted 为 false
    enabled?: boolean;
    //  超过该体积（MB）才拆分，默认 24
    thresholdMB?: number;
    //  每片体积（MB），默认 20
    chunkSizeMB?: number;
  };
  minSupportedVersion?: string;
  prebuiltConfig: PrebuiltConfigType;
};
