// SeedHub 全量索引器 v2：抓所有列表页，落地 data/index.json
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { SeedHub } from "./adapters/seedhub.mjs";
import pathsCjs from "./paths.cjs";
const { resolveDataDir } = pathsCjs;

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = process.env.QUARK_DATA_DIR || resolveDataDir({ root: ROOT });
const OUT = path.join(DATA_DIR, "index.json");
const PROG = path.join(ROOT, "out", "index-progress.txt");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.mkdirSync(path.dirname(PROG), { recursive: true });

const WORKERS = Number(process.argv[2] || 5);
const MAX_PAGE = Number(process.argv[3] || 2160);
const log = (m) => { const s = "[" + new Date().toLocaleTimeString() + "] " + m; fs.appendFileSync(PROG, s + "\n"); console.log(s); };
fs.writeFileSync(PROG, "");

const browser = await chromium.launch({ channel: "msedge", headless: true });
const found = new Map();
let done = 0, failed = 0;
const t0 = Date.now();

// 启动时合并已有索引，只补缺，不从头再来
try {
  const old = JSON.parse(fs.readFileSync(OUT, "utf8"));
  for (const it of old.items || []) found.set(it.id, it);
  log("载入已有索引 " + found.size + " 条，本次只做补齐");
} catch { log("无已有索引，全量抓取"); }

// 边抓边写：搜索立刻可用，不用等全量跑完
let flushCount = 0;
function flush(final) {
  const list = [...found.values()].sort((a, b) => Number(b.id) - Number(a.id));
  const tmp = OUT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ builtAt: Date.now(), source: "seedog.cc", partial: !final, count: list.length, items: list }));
  fs.renameSync(tmp, OUT);
  flushCount++;
}

async function worker(start) {
  const sh = new SeedHub({ browser });
  for (let n = start; n <= MAX_PAGE; n += WORKERS) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const { status, items } = await sh.listPage(n);
        if (status === 200 && items.length) { for (const it of items) found.set(it.id, it); ok = true; }
      } catch { /* retry */ }
      if (!ok) await new Promise((r) => setTimeout(r, 800));
    }
    if (!ok) failed++;
    done++;
    if (done % 50 === 0) {
      log(`进度 ${done} 页 / 收录 ${found.size} 条 / 失败 ${failed} / ${((Date.now()-t0)/1000).toFixed(0)}s`);
      flush(false);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  await sh.close();
}

log("开始全量索引：1-" + MAX_PAGE + " 页，" + WORKERS + " 并发");
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1).catch((e) => log("worker err " + e.message))));

flush(true);
log("完成：收录 " + list.length + " 条 / 失败 " + failed + " 页，耗时 " + ((Date.now() - t0) / 1000).toFixed(0) + "s");
await browser.close();
