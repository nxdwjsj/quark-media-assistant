// 数据目录解析：程序目录可以整体替换，data/ 永远不动。
//
// 为什么要独立成一个文件：Electron 主进程（CJS）和服务进程（ESM）都要用同一套规则，
// 各写一份迟早会跑偏 —— 一旦两边指向不同的目录，就会出现「设置了登录态但搜索说没登录」。
//
// 规则（先命中先用，且都要可写）：
//   1. 环境变量 QUARK_DATA_DIR —— 显式指定，测试和多实例并存时用
//   2. 打包后：exe 同级的 data/ —— 整个文件夹拷走就能用，更新只换程序文件
//      （electron-builder 的 portable 单文件会把程序解压到临时目录，此时
//        PORTABLE_EXECUTABLE_DIR 指向用户双击的那个 exe，取它才不会被临时目录坑）
//   3. 上一步不可写（例如装在 Program Files）→ %LOCALAPPDATA%\夸克影视助手\data
//   4. 开发模式（未打包）→ 项目目录下的 data/
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "夸克影视助手";

// 探针式判断：目录存在不等于能写（只读目录、权限受限都会在这里露馅）
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-probe");
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir(opts = {}) {
  const env = opts.env || process.env;
  const root = opts.root || process.cwd();

  if (env.QUARK_DATA_DIR) {
    const explicit = path.resolve(env.QUARK_DATA_DIR);
    if (writable(explicit)) return explicit;
  }

  if (opts.isPackaged) {
    const exeDir = env.PORTABLE_EXECUTABLE_DIR || path.dirname(opts.execPath || process.execPath);
    const beside = path.join(exeDir, "data");
    if (writable(beside)) return beside;

    const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const userDir = path.join(base, APP_NAME, "data");
    if (writable(userDir)) return userDir;

    return beside; // 都不可写：返回可预期的路径，让上层报错时指得清楚
  }

  return path.join(root, "data");
}

module.exports = { resolveDataDir, APP_NAME, writable };
