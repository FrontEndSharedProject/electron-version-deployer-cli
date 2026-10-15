export const CLI_NAME = "electron-version-deployer-cli";
export const CONFIG_FILE_NAME = "evd.config.js";

export const SPLIT_FOLDER_NAME = "fullCodeZipSplitZips";
export const FULL_CODE_ZIP_NAME = "fullCode.zip";
export const LOGIC_SPLIT_FOLDER_NAME = "logicCodeZipSplitZips";
export const LOGIC_CODE_ZIP_NAME = "logicCode.zip";

export const SPLIT_TARGETS = [
  { zipName: LOGIC_CODE_ZIP_NAME, splitFolderName: LOGIC_SPLIT_FOLDER_NAME },
  { zipName: FULL_CODE_ZIP_NAME, splitFolderName: SPLIT_FOLDER_NAME },
] as const;
