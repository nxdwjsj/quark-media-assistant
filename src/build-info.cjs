// 版本标识：出问题时第一件事是确认「跑的是哪一版」——没有它，更新和回滚都无从谈起。
//
// 打包时由 scripts/build-portable.mjs 写入 build-info.json（和 package.json 同目录）；
// 开发模式没有这个文件，就回落到 package.json 的版本号 + 当前 git 短哈希。
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function gitShortHash(root) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
    }).trim() || null;
  } catch {
    return null; // 打包后的 resources/app 里没有 .git，拿不到是正常的
  }
}

function readBuildInfo(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, "build-info.json"), "utf8"));
    if (j && j.version) return Object.assign({ mode: "portable", gitHash: null, builtAt: null }, j, { source: "build-info.json" });
  } catch {}

  let version = "0.0.0";
  try { version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || version; } catch {}
  return { version, mode: "dev", gitHash: gitShortHash(root), builtAt: null, source: "package.json" };
}

// 一行给人看的版本串，例如 "1.0.0 (a741d1d, 2026-10-08 11:30)"
function versionLine(info) {
  const parts = [];
  if (info.gitHash) parts.push(info.gitHash);
  if (info.builtAt) parts.push(String(info.builtAt).replace("T", " ").slice(0, 16));
  return info.version + (parts.length ? " (" + parts.join(", ") + ")" : "");
}

module.exports = { readBuildInfo, versionLine };
