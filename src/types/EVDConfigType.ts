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
  //  这将会在部署时将文件夹里面的内容，一同部署到服务器上
  //  文件会被放在根目录的 basename 文件中，比如
  // 传入 ['public/test'] 这样一个文件夹，那么最终会被放到根目录的
  // /test 中
  // 注意:当个文件不能超过 25mb 这是 cloudflare 的限制（仅 cloudflare 适用）
  // 注意：必须使用相对路径，相对路径谁相对于 evd.config.ts 文件
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
