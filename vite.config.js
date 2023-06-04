import { join } from "node:path";
import pkg from "./package.json";

const PACKAGE_ROOT = __dirname;
const PROJECT_ROOT = join(PACKAGE_ROOT, "../..");

/**
 * @type {import('vite').UserConfig}
 * @see https://vitejs.dev/config/
 */
const config = {
  mode: process.env.MODE,
  root: PACKAGE_ROOT,
  envDir: PROJECT_ROOT,
  define: {
    "import.meta.env.PKG_NAME": `"${pkg.name}"`,
    "import.meta.env.PKG_VERSION": `"${pkg.version}"`,
  },
  resolve: {
    alias: {
      "@/": `${join(PACKAGE_ROOT, "src")}/`,
    },
  },
  build: {
    ssr: false,
    sourcemap: false,
    outDir: "dist",
    assetsDir: ".",
    minify: false,
    lib: {
      entry: ["src/index.ts"],
      formats: ["cjs", "es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "[name].[format].js",
      },
    },
    emptyOutDir: false,
    reportCompressedSize: false,
  },
};

export default config;
