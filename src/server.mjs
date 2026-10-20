// 夸克影视助手 · 本地服务（v2：浏览器不进热路径）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { chromium } from "playwright-core";
import { SeedHub } from "./adapters/seedhub.mjs";
import { SiteB } from "./adapters/siteb.mjs";
import { SUBS_EXT, decodeSubText, toVtt, subLang, subScore, cuesToVtt, shiftVtt } from "./subs.mjs";
import { SUB_HANDLERS, locateMoovForward, locateMoovBackward, parseTracks, sampleOffsets, sampleTimes, decodeTx3g, mergeRanges, sliceSample } from "./mp4subs.mjs";
import pathsCjs from "./paths.cjs";
import buildInfoCjs from "./build-info.cjs";
const { resolveDataDir } = pathsCjs;
const { readBuildInfo, versionLine } = buildInfoCjs;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// 可写数据目录：Electron 壳通过 QUARK_DATA_DIR 传进来（打包后是 exe 同级的 data/）；
// 直接用 node 跑这个文件（开发模式）时自己解析，落在项目里的 data/
const DATA_DIR = process.env.QUARK_DATA_DIR || resolveDataDir({ root: ROOT });
const BUILD = readBuildInfo(ROOT);
// 端口候选：PORT 环境变量优先；8787 可能落在 Windows 的保留端口段（Hyper-V/WSL 动态保留，
// listen 直接 EACCES），所以依次回退。实际监听端口会写进 data/server.port 供 Electron 壳发现。
const PORT_LIST = [...new Set([Number(process.env.PORT || 8787), 8787, 8888, 8890, 8791, 8788])].filter(Number);
const PORT_FILE = path.join(DATA_DIR, "server.port");
const PROFILE = path.join(DATA_DIR, "browser-profile");
const COOKIE_FILE = path.join(DATA_DIR, "cookies.json");
const SAVE_DIR = process.env.SAVE_DIR || "影视自动化";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const QUARK_API = "https://drive-pc.quark.cn";
const COOKIE_TTL = 10 * 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;

let qctx = null, qpage = null, seedBrowser = null, seed = null;
let cookieCache = { at: 0, value: "", ok: false };

/* ---------- Cookie：优先用磁盘缓存，后台刷新，绝不阻塞请求 ---------- */
function loadCookieFile() {
  try {
    const j = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
    if (j.value && Date.now() - j.at < 12 * 60 * 60 * 1000) { cookieCache = { at: j.at, value: j.value, ok: true }; return true; }
  } catch {}
  return false;
}
function saveCookieFile() { try { fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true }); fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookieCache)); } catch {} }

let refreshing = null;
async function refreshCookies() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      if (!qctx) {
        qctx = await chromium.launchPersistentContext(PROFILE, { channel: "msedge", headless: true, locale: "zh-CN" });
        qpage = qctx.pages()[0] || (await qctx.newPage());
        if (!qpage.url().startsWith("https://pan.quark.cn")) {
          await qpage.goto("https://pan.quark.cn/list#/list/all", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        }
      }
      // 必须把 b.quark.cn / .uop.quark.cn 这些域下的 cookie 也带上：夸克 CDN 取流（字幕文件、下载直链）
      // 只要少了它们就一律 412 Precondition Failed。原先按 https://pan.quark.cn 过滤，会漏掉
      // broccoli-user-id、__itrace_wid、_UP_28A_52_ 等，导致「接口能通、直链取了却下不动」。
      const all = await qctx.cookies();
      const cs = all.filter((c) => /(^|\.)quark\.cn$/.test(c.domain));
      const names = cs.map((c) => c.name);
      if (!names.includes("__uid") || !names.includes("__puus")) throw new Error("夸克网盘登录态已失效，点界面上的「重新登录夸克」重新扫码即可");
      // 同名 cookie 优先保留更贴近 pan.quark.cn 的那个（Chrome 也是这个顺序）
      const rank = (d) => (d === "pan.quark.cn" ? 0 : d === ".quark.cn" ? 1 : 2);
      const seen = new Set();
      const jar = cs.slice().sort((a, b) => rank(a.domain) - rank(b.domain)).filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
      cookieCache = { at: Date.now(), value: jar.map((c) => c.name + "=" + c.value).join("; "), ok: true };
      saveCookieFile();
    } catch (e) {
      cookieCache.ok = false;
      console.error("[cookie] " + (e?.message || e));
    } finally { refreshing = null; }
  })();
  return refreshing;
}
function cookieHeader() { return cookieCache.value; }

/* ---------- Quark API：纯 fetch，带 UA/Referer/Cookie ---------- */
async function quarkApi(pathname, init = {}, timeoutMs = 20000) {
  if (!cookieHeader()) { await refreshCookies(); if (!cookieHeader()) throw new Error("网盘登录态不可用"); }
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(QUARK_API + pathname, {
        ...init,
        headers: { "User-Agent": UA, "Referer": "https://pan.quark.cn/", "Cookie": cookieHeader(), "Content-Type": "application/json", ...(init.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      if ((r.status === 401 || r.status === 412 || /未登录|登录已?失效/.test(text)) && cookieCache.ok) {
        cookieCache = { at: 0, value: "", ok: false };
        await refreshCookies();
      }
      return { status: r.status, text };
    } catch (e) {
      // 并发取内封字幕时同一条连接上偶发 DNS/TLS 抖动，退避重试即可
      lastErr = e;
      if (attempt < 2) await new Promise((rr) => setTimeout(rr, 400 * (attempt + 1)));
    }
  }
  throw new Error("请求夸克接口失败：" + ((lastErr && lastErr.message) || "网络错误"));
}

let bctx = null, siteb = null;
async function ensureSiteB() {
  if (siteb) {
    // 浏览器崩了/被外部关掉时，别拿着死句柄一直失败，直接重开一个
    let alive = false;
    try { const b = bctx && bctx.browser(); alive = !!(b && b.isConnected()); } catch (e) { alive = false; }
    if (alive) return siteb;
    try { await bctx.close(); } catch (e) {}
    bctx = null; siteb = null;
  }
  bctx = await launchSiteB({ headless: true });
  bctx.on("close", () => { bctx = null; siteb = null; });
  siteb = new SiteB({ browser: bctx });
  return siteb;
}

function sitebProfileDir() { return path.join(DATA_DIR, "siteb-profile"); }

// 人机验证卡住时，整个浏览器状态可能已经坏了：关掉重开一次再去搜
async function resetSiteB() {
  try { if (bctx) await bctx.close(); } catch (e) {}
  bctx = null; siteb = null;
  await new Promise((r) => setTimeout(r, 1200));
}

// 同一个 profile 目录同时只能有一个浏览器进程。上次没退干净的 Edge 会把它锁住，
// 新浏览器起不来（或者起来但读不到登录 Cookie）→ 表现就是「人机验证一直过不去」。
async function launchSiteB({ headless }) {
  try {
    return await chromium.launchPersistentContext(sitebProfileDir(), {
      channel: "msedge", headless, locale: "zh-CN",
      ...(headless ? {} : { viewport: { width: 1440, height: 900 } }),
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    throw new Error("站点 B 的浏览器没能启动。常见原因：上一次的 Edge / 浏览器进程没退干净，占着 data/siteb-profile 这个配置目录。" +
      "（关掉多余的 msedge.exe，或重启 App 再试）原始错误：" + msg.split("\n")[0]);
  }
}

/* 站点 B 重新登录：在真实桌面上弹一个可见窗口，用户手动过验证/登录一次，
   Cookie 落回 data/siteb-profile，之后 headless 搜索继续用。
   做成「起一次 + 轮询状态」，避免挂一个几分钟不返回的 HTTP 请求。 */
let relogin = { running: false, ok: false, message: "还没开始", at: 0 };
const RELOGIN_TIMEOUT_MS = 7 * 60 * 1000;
function doRelogin() {
  if (relogin.running) return relogin;
  relogin = { running: true, ok: false, message: "正在打开浏览器窗口…", at: Date.now() };
  (async () => {
    let ctx = null;
    try {
      try { if (bctx) await bctx.close(); } catch (e) {}
      bctx = null; siteb = null;
      await new Promise((r) => setTimeout(r, 1500));   // 等 headless 那把锁真正放开
      ctx = await launchSiteB({ headless: false });
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto("https://www.hgeme.com/user/login", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      relogin.message = "请在弹出的窗口里完成人机验证 / 登录";
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < RELOGIN_TIMEOUT_MS) {
        await page.waitForTimeout(2000);
        let cs = [];
        try { cs = await ctx.cookies(); } catch (e) { break; }
        if (cs.some((c) => c.name === "auth_token" && c.value)) { ok = true; break; }
        relogin.message = "等待登录…剩余 " + Math.max(0, Math.round((RELOGIN_TIMEOUT_MS - (Date.now() - t0)) / 1000)) + " 秒";
      }
      if (ok) await page.waitForTimeout(1500);
      // 注意：这之后还要重开无头上下文 + 预热，全程都算 running。
      // 否则界面会抢先以为「已完成」，用户马上搜索就会和我们自己的预热抢同一个 profile。
      relogin.message = ok ? "正在切回后台模式…" : "没检测到登录态，正在收尾…";
      try { if (ctx) await ctx.close(); } catch (e) {}
      ctx = null;
      await new Promise((r) => setTimeout(r, 1500));

      let reopened = false;
      for (let i = 0; i < 30 && ok && !reopened; i++) {
        try {
          bctx = await launchSiteB({ headless: true });
          bctx.on("close", () => { bctx = null; siteb = null; });
          siteb = new SiteB({ browser: bctx });
          reopened = true; break;
        } catch (e) { await new Promise((r) => setTimeout(r, 1200)); }
      }

      if (!ok) {
        relogin = { running: false, ok: false, at: Date.now(), message: "没检测到登录态，窗口已关闭，可以再试一次" };
      } else if (!reopened) {
        relogin = { running: false, ok: false, at: Date.now(), message: "登录成功了，但站点 B 的浏览器配置目录还被占用，没能切回后台模式。关掉多余的 Edge 窗口或重启 App 再试。" };
      } else {
        // 刚被可见窗口用过的会话，第一次往往验证不过去：先内部把搜索页跑通，
        // 跑不通就把浏览器整个重开，直到真正就绪，用户接下来的搜索才是秒回。
        let warm = false, tries = 0;
        for (; tries < 5 && !warm; tries++) {
          try { warm = await siteb.warmup({ tries: 1 }); } catch (e) { warm = false; }
          if (!warm) { await resetSiteB(); try { await ensureSiteB(); } catch (e) {} }
        }
        relogin = { running: false, ok: true, at: Date.now(), message: warm ? "登录成功，可以重新搜索了" : "登录成功，但站点 B 还在验证中，搜索时可能要再试一次" };
      }
    } catch (e) {
      relogin = { running: false, ok: false, message: "重新登录失败：" + ((e && e.message) || String(e)), at: Date.now() };
      try { if (ctx) await ctx.close(); } catch (e2) {}
      await new Promise((r) => setTimeout(r, 1000));
      bctx = null; siteb = null;
    }
  })();
  return relogin;
}

/* 夸克重新登录：和站点 B 同一套路数，区别只在认的 Cookie 是 __uid + __puus。
   为什么必须做在应用里：打包版不含 scripts/ 目录、也没有控制台，登录一过期就再也没有
   自救手段，只能重装。这里弹一个可见窗口让用户扫码/登录，成功后自动切回无头模式。 */
let qRelogin = { running: false, ok: false, message: "还没开始", at: 0 };
const Q_RELOGIN_TIMEOUT_MS = 7 * 60 * 1000;

async function closeQuarkCtx() {
  try { if (qctx) await qctx.close(); } catch (e) {}
  qctx = null; qpage = null;
}

function quarkCookieNames(cs) {
  return cs.filter((c) => /(^|\.)quark\.cn$/.test(c.domain)).map((c) => c.name);
}

function doQuarkRelogin() {
  if (qRelogin.running) return qRelogin;
  qRelogin = { running: true, ok: false, message: "正在打开浏览器窗口…", at: Date.now() };
  (async () => {
    let ctx = null;
    try {
      await closeQuarkCtx();
      await new Promise((r) => setTimeout(r, 1500));   // 等无头那边把 profile 锁真正放开
      try {
        ctx = await chromium.launchPersistentContext(PROFILE, {
          channel: "msedge", headless: false, locale: "zh-CN", viewport: { width: 1440, height: 900 },
        });
      } catch (e) {
        throw new Error("夸克的浏览器没能启动，多半是上一次的 Edge 进程还占着 data/browser-profile" +
          "（关掉多余的 msedge.exe 再试）。原始错误：" + String((e && e.message) || e).split("\n")[0]);
      }
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto("https://pan.quark.cn/list#/list/all", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      qRelogin.message = "请在弹出的窗口里登录夸克网盘（扫码或账号密码都行）";
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < Q_RELOGIN_TIMEOUT_MS) {
        await page.waitForTimeout(2000);
        let cs = [];
        try { cs = await ctx.cookies(); } catch (e) { break; }
        const names = quarkCookieNames(cs);
        if (names.includes("__uid") && names.includes("__puus")) { ok = true; break; }
        qRelogin.message = "等待登录…剩余 " + Math.max(0, Math.round((Q_RELOGIN_TIMEOUT_MS - (Date.now() - t0)) / 1000)) + " 秒";
      }
      if (ok) await page.waitForTimeout(1500);
      // 这之后还要重开无头上下文并刷新 Cookie，全程都算 running；
      // 否则界面会抢先以为「已完成」，用户马上点播放就会和我们自己抢同一个 profile。
      qRelogin.message = ok ? "正在切回后台模式…" : "没检测到登录态，正在收尾…";
      try { if (ctx) await ctx.close(); } catch (e) {}
      ctx = null;
      await new Promise((r) => setTimeout(r, 1500));

      let reopened = false;
      for (let i = 0; i < 30 && ok && !reopened; i++) {
        try {
          qctx = await chromium.launchPersistentContext(PROFILE, { channel: "msedge", headless: true, locale: "zh-CN" });
          qpage = qctx.pages()[0] || (await qctx.newPage());
          reopened = true; break;
        } catch (e) { await new Promise((r) => setTimeout(r, 1200)); }
      }

      if (!ok) {
        qRelogin = { running: false, ok: false, at: Date.now(), message: "没检测到登录态，窗口已关闭，可以再试一次" };
      } else if (!reopened) {
        qRelogin = { running: false, ok: false, at: Date.now(), message: "登录成功了，但浏览器配置目录还被占用，没能切回后台模式。关掉多余的 Edge 窗口或重启应用再试。" };
      } else {
        cookieCache = { at: 0, value: "", ok: false };
        await refreshCookies();
        qRelogin = cookieCache.ok
          ? { running: false, ok: true, at: Date.now(), message: "登录成功，可以继续用了" }
          : { running: false, ok: false, at: Date.now(), message: "登录动作完成，但没读到夸克 Cookie，请退出应用重开一次" };
      }
    } catch (e) {
      qRelogin = { running: false, ok: false, message: "重新登录失败：" + ((e && e.message) || String(e)), at: Date.now() };
      try { if (ctx) await ctx.close(); } catch (e2) {}
      await new Promise((r) => setTimeout(r, 1000));
      await closeQuarkCtx();
    }
  })();
  return qRelogin;
}

// 兜底超时：宁可给一条明确的错误，也不要让界面的「人机验证」转圈转到天荒地老
function withTimeout(p, ms, msg) {
  let timer = null;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => { if (timer) clearTimeout(timer); });
}

// 站点 B 的搜索结果按「关键词|模式|页码」缓存 10 分钟：
// 它的搜索是实时的、没法索引，但同一个词翻来翻去没必要每次重跑一遍浏览器
const bPageCache = new Map();
const B_TTL = 10 * 60 * 1000;
async function bSearchCached(q, mode, pages) {
  const sb = await ensureSiteB();
  const all = [];
  let counts = null, total = 0, hit = 0, firstErr = "";
  // 先看缓存，未命中的页并发去抓
  const miss = [];
  const pagesData = new Array(pages);
  for (let p = 1; p <= pages; p++) {
    const key = q + "|" + mode + "|" + p;
    const c = bPageCache.get(key);
    if (c && Date.now() - c.at < B_TTL) { pagesData[p - 1] = c.data; hit++; }
    else miss.push(p);
  }
  if (miss.length) {
    let got = await sb.searchPages(q, { pages: Math.max(...miss), concurrency: 3, mode });
    // 所有页都挂了（人机验证卡住 / 浏览器状态坏掉）：重开一个浏览器再试一轮
    const allFailed = miss.every((p) => { const d = got[p - 1]; return !d || (d.error && !(d.items || []).length); });
    if (allFailed) {
      await resetSiteB();
      const sb2 = await ensureSiteB();
      got = await sb2.searchPages(q, { pages: Math.max(...miss), concurrency: 3, mode });
    }
    for (const p of miss) {
      const data = got[p - 1] || { items: [], counts: null, total: 0, empty: true };
      if (!firstErr && data.error) firstErr = data.error;
      // 只有拿到真实结果才写缓存：人机验证/登录态失败不该被缓存 10 分钟
      if (!data.error) bPageCache.set(q + "|" + mode + "|" + p, { at: Date.now(), data });
      pagesData[p - 1] = data;
    }
  }
  for (let p = 1; p <= pages; p++) {
    const d = pagesData[p - 1];
    if (!d) break;
    if (!counts && d.counts) { counts = d.counts; total = d.total; }
    all.push(...d.items);
    if (d.empty) break;
  }
  const seen = new Set();
  return { counts, total, fromCache: hit === pages, cachedPages: hit, error: firstErr || undefined, items: all.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true))) };
}

/* ---------- 失效链接检测（走网页接口，比 CLI 快 5 倍） ---------- */
async function checkShareUrl(url) {
  const t0 = Date.now();
  const pwdId = (String(url).split("/s/")[1] || "").split("?")[0];
  if (!pwdId) return { ok: false, why: "不是夸克分享链接", ms: Date.now() - t0 };
  const mPwd = String(url).match(/pwd=([A-Za-z0-9]+)/);
  try {
    const r1 = await quarkApi("/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc", {
      method: "POST", body: JSON.stringify({ pwd_id: pwdId, passcode: mPwd ? mPwd[1] : "" }),
    });
    const j1 = JSON.parse(r1.text);
    if (j1.code !== 0) return { ok: false, why: "token " + j1.code + " " + (j1.message || ""), ms: Date.now() - t0 };
    const r2 = await quarkApi("/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=" + pwdId + "&stoken=" + encodeURIComponent(j1.data.stoken) + "&pdir_fid=0&force=0&_page=1&_size=10&_fetch_banner=0&_fetch_share=1&_fetch_total=1");
    const j2 = JSON.parse(r2.text);
    const sh = (j2.data && j2.data.share) || {};
    const list = (j2.data && j2.data.list) || [];
    if (j2.code !== 0) return { ok: false, why: "detail " + j2.code + " " + (j2.message || ""), ms: Date.now() - t0 };
    if (!list.length) return { ok: false, why: "分享内容为空", ms: Date.now() - t0 };
    const stat = {
      title: sh.title || "", count: list.length,
      allFiles: sh.all_file_num ?? null,       // 整个分享（含子文件夹）的文件总数
      fileOnly: sh.file_only_num ?? null,      // 只算文件
      videoTotal: sh.video_total ?? null,
      size: sh.size ?? null,                   // 总字节数
      innerTotal: j2.metadata && j2.metadata._total != null ? j2.metadata._total : null,
      ms: Date.now() - t0,
    };
    // 注意：partial_violation=true 只表示「部分文件」被清理，分享依然可用（实测过，
    // 曾经把它当失效处理，导致大量非空文件夹被误判），所以只降级为提示。
    if (sh.partial_violation) return Object.assign(stat, { ok: true, warn: true, why: "可用（部分内容已被清理）" });
    return Object.assign(stat, { ok: true, why: "可用" });
  } catch (e) {
    return { ok: false, why: "检测异常 " + (e && e.message ? e.message.slice(0, 40) : ""), ms: Date.now() - t0 };
  }
}

async function checkMany(urls, concurrency = 4) {
  const out = {};
  const queue = urls.slice();
  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      if (!u || out[u]) continue;
      out[u] = /pan.quark.cn/.test(u) ? await checkShareUrl(u) : { ok: null, why: "非夸克链接，未检测" };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, urls.length)) }, worker));
  return out;
}

async function ensureSeed() {
  if (seed) return;
  seedBrowser = await chromium.launch({ channel: "msedge", headless: true });
  seed = new SeedHub({ browser: seedBrowser });
}

/* ---------- 本地索引 ---------- */
const INDEX_FILE = path.join(DATA_DIR, "index.json");
let indexCache = null, indexMtime = 0;
function loadIndex() {
  try {
    const st = fs.statSync(INDEX_FILE);
    if (!indexCache || st.mtimeMs !== indexMtime) { indexCache = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")); indexMtime = st.mtimeMs; }
    return indexCache;
  } catch { return null; }
}

/* ---------- 索引保鲜：周期性抓「最近 N 页」合并进来 ---------- */
let refreshingIdx = null;
async function refreshRecent(pages = 30) {
  if (refreshingIdx) return refreshingIdx;
  refreshingIdx = (async () => {
    try {
      await ensureSeed();
      const found = new Map();
      try { const old = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")); for (const it of old.items || []) found.set(it.id, it); } catch {}
      const before = found.size;
      const results = await Promise.all(Array.from({ length: pages }, (_, i) => seed.listPage(i + 1).catch(() => ({ items: [] }))));
      for (const r of results) for (const it of r.items || []) found.set(it.id, it);
      const arr = [...found.values()].sort((a, b) => Number(b.id) - Number(a.id));
      const tmp = INDEX_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ builtAt: Date.now(), source: "seedog.cc", count: arr.length, items: arr }));
      fs.renameSync(tmp, INDEX_FILE);
      indexCache = null;
      console.log("[index] 增量更新完成：+" + (arr.length - before) + " 条，共 " + arr.length + " 条");
      return arr.length;
    } catch (e) { console.error("[index] 增量更新失败 " + (e?.message || e)); }
    finally { refreshingIdx = null; }
  })();
  return refreshingIdx;
}

/* ---------- 视频列表（缓存 + 预热播放地址） ---------- */
let videosCache = { at: 0, list: [], building: null };
async function listVideos(force) {
  if (!force && videosCache.list.length && Date.now() - videosCache.at < CACHE_MS) return videosCache.list;
  if (videosCache.building) return videosCache.building;
  videosCache.building = (async () => {
    const out = [];
    const roots = ["影视", "QuarkSpike", SAVE_DIR];
    const r0 = await quarkApi("/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=0&_page=1&_size=100&_fetch_total=1");
    const j0 = JSON.parse(r0.text);
    const dirs = (j0.data?.list || []).filter((f) => f.file_type === 0 && roots.includes(f.file_name));
    const seen = new Set();
    const walk = async (pdir, depth) => {
      if (depth > 3 || out.length >= 500) return;
      const rr = await quarkApi("/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=" + pdir + "&_page=1&_size=200&_fetch_total=1");
      const jj = JSON.parse(rr.text);
      for (const f of jj.data?.list || []) {
        if (f.file_type === 0) await walk(f.fid, depth + 1);
        else if (/^(video|mkv|mp4|avi|mov|flv|ts|wmv|webm)/i.test(f.format_type || "")) {
          if (seen.has(f.fid)) continue; seen.add(f.fid);
          out.push({ fid: f.fid, name: f.file_name, size: f.size, fmt: f.format_type });
        }
      }
    };
    for (const d of dirs) await walk(d.fid, 1);
    videosCache = { at: Date.now(), list: out, building: null };
    prewarm(out.slice(0, 8));
    return out;
  })().catch((e) => { videosCache.building = null; throw e; });
  return videosCache.building;
}
function prewarm(items) {
  (async () => { for (const it of items) { try { await getPlayUrl(it.fid, "super"); } catch {} } })();
}

/* ---------- 播放地址 ---------- */
const playCache = new Map();
// 画质：默认取像素数最高的那档（之前默认 super 档 1440x810/2500kbps，看着发虚）
function pickRendition(list, res) {
  if (!list.length) return null;
  if (res) { const m = list.find((v) => v.resolution === res); if (m) return m; }
  return list.slice().sort((a, b) => {
    const pa = (a.video_info.width || 0) * (a.video_info.height || 0);
    const pb = (b.video_info.width || 0) * (b.video_info.height || 0);
    if (pb !== pa) return pb - pa;
    return (b.video_info.bitrate || 0) - (a.video_info.bitrate || 0);
  })[0];
}

async function getPlayUrl(fid, res) {
  const key = fid + "|" + (res || "best");
  const c = playCache.get(key);
  if (c && Date.now() - c.at < 20 * 60 * 1000) return c;
  const r = await quarkApi("/1/clouddrive/file/v2/play?pr=ucpro&fr=pc", { method: "POST", body: JSON.stringify({ fid }) });
  const j = JSON.parse(r.text);
  if (!j.data || !j.data.video_list) throw new Error((j.message || "无播放地址") + " " + r.text.slice(0, 120));
  const list = j.data.video_list;
  // 先在「全部档位」里按像素挑最高的（曾经按「是否含 m3u8」挑，导致高清档是直连文件时被跳过、
  // 只挑到 HLS 里最差的那档）；挑完之后再按这一档自己的格式决定走 HLS 还是直连。
  const pick = pickRendition(list, res) || list[0];
  const isHls = String(pick.video_info.format || "").includes("m3u8");
  const url = pick.video_info.url;
  const vi = pick.video_info || {};
  const streams = (() => { const s = vi.streams; if (!s) return {}; try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return {}; } })();
  const rec = {
    at: Date.now(), url,
    kind: isHls ? "hls" : "file",
    format: vi.format,
    size: vi.size,
    width: vi.width, height: vi.height, bitrate: vi.bitrate,
    current: pick.resolution,
    base: url.slice(0, url.lastIndexOf("/") + 1),
    resolutions: list.map((v) => ({ name: v.resolution, w: v.video_info.width, h: v.video_info.height, bitrate: v.video_info.bitrate })),
    name: j.data.file_name,
    // 内封字幕轨：夸克只给 index/lang，没有直链（转码 m3u8 里也没有 SUBTITLES 轨）
    embedded: (streams.subtitle_stream_list || []).map((s) => ({ index: String(s.index), lang: s.lang || "" })),
  };
  playCache.set(key, rec);
  return rec;
}

async function fetchCdn(url, extra = {}) {
  return fetch(url, {
    headers: { "User-Agent": UA, "Referer": "https://pan.quark.cn/", "Cookie": cookieHeader(), ...extra },
    signal: AbortSignal.timeout(30000),
  });
}

// 取流被 CDN 拒（412）时自愈。为什么必须主动做：本地 cookie 过期后，**网页接口（列表/搜索）
// 往往还认这套旧 cookie**，于是 quarkApi 不会触发刷新，只有取视频流这一路会 412 ——
// 表现就是「列表正常、一点视频就播不了」，而且一直不自愈。
// 只重读 cookies.json 没用（它本身就是旧的），必须关掉浏览器上下文重新采集。
let healing = null;
function healSession() {
  if (healing) return healing;
  healing = (async () => {
    console.error("[cookie] 取流被拒，重新采集登录态…");
    cookieCache = { at: 0, value: "", ok: false };
    try { if (qctx) await qctx.close(); } catch (e) {}
    qctx = null; qpage = null;
    await refreshCookies();
    console.error("[cookie] 重新采集完成 ok=" + cookieCache.ok + " 长度=" + cookieCache.value.length);
  })().finally(() => { healing = null; });
  return healing;
}

// 取 CDN 资源；412/401 时先自愈，再用（必要时重新解析出的）地址试一次
async function cdnGet(url, extra, refreshUrl) {
  let r = await fetchCdn(url, extra);
  if (r.status !== 412 && r.status !== 401) return { r, url };
  try { await r.body?.cancel(); } catch (e) {}
  await healSession();
  if (!cookieHeader()) return { r, url };
  let u2 = url;
  if (refreshUrl) { try { u2 = (await refreshUrl()) || url; } catch (e) {} }
  return { r: await fetchCdn(u2, extra), url: u2 };
}

const shareUrlCache = new Map(); // link_start href -> 解析后的分享地址

/* ---------- 一键转存：新建以资源名命名的文件夹 + 整包转存 ---------- */
const jobs = new Map();
function newJob() { const id = Math.random().toString(36).slice(2, 10); jobs.set(id, { id, step: "排队中", ok: null, startedAt: Date.now() }); return id; }
setInterval(() => { const now = Date.now(); for (const [k, v] of jobs) if (now - v.startedAt > 30 * 60 * 1000) jobs.delete(k); }, 60000).unref?.();

// 走网页接口读分享目录：比 CLI 快好几倍，还能拿到「本层总数」和整包统计
// 同一个分享的 stoken 缓存 10 分钟：批量查子目录时不必反复换 token
const stokenCache = new Map();
const STOKEN_TTL = 10 * 60 * 1000;
async function getStoken(url, passcode = "") {
  const pwdId = (String(url).split("/s/")[1] || "").split("?")[0];
  const mPwd = String(url).match(/pwd=([A-Za-z0-9]+)/);
  const pass = passcode || (mPwd ? mPwd[1] : "");
  const key = pwdId + "|" + pass;
  const hit = stokenCache.get(key);
  if (hit && Date.now() - hit.at < STOKEN_TTL) return { pwdId, stoken: hit.stoken };
  const r1 = await quarkApi("/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc", { method: "POST", body: JSON.stringify({ pwd_id: pwdId, passcode: pass }) });
  const j1 = JSON.parse(r1.text);
  if (j1.code !== 0) throw new Error((j1.message || "分享不可用") + " (" + j1.code + ")");
  stokenCache.set(key, { at: Date.now(), stoken: j1.data.stoken });
  return { pwdId, stoken: j1.data.stoken };
}

// 只读某一层的条目总数（_size=1，报文极小）
async function shareFolderCount(url, pdir, passcode = "") {
  const s = await getStoken(url, passcode);
  const r = await quarkApi("/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=" + s.pwdId + "&stoken=" + encodeURIComponent(s.stoken) + "&pdir_fid=" + pdir + "&force=0&_page=1&_size=1&_fetch_banner=0&_fetch_share=0&_fetch_total=1");
  const j = JSON.parse(r.text);
  if (j.code !== 0) return null;
  return j.metadata && j.metadata._total != null ? j.metadata._total : null;
}

async function shareDetailFast(url, pdir = "0", passcode = "") {
  const s = await getStoken(url, passcode);
  const pwdId = s.pwdId, stoken = s.stoken;
  const r2 = await quarkApi("/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=" + pwdId + "&stoken=" + encodeURIComponent(stoken) + "&pdir_fid=" + pdir + "&force=0&_page=1&_size=200&_fetch_banner=0&_fetch_share=1&_fetch_total=1");
  const j2 = JSON.parse(r2.text);
  if (j2.code !== 0) throw new Error(j2.message || "读取失败");
  const sh = (j2.data && j2.data.share) || {};
  return {
    total: j2.metadata && j2.metadata._total != null ? j2.metadata._total : null,
    allFiles: sh.all_file_num ?? null,
    fileOnly: sh.file_only_num ?? null,
    size: sh.size ?? null,
    videoTotal: sh.video_total ?? null,
    title: sh.title || "",
    items: ((j2.data && j2.data.list) || []).map((f) => ({
      fid: f.fid, name: f.file_name,
      dir: f.dir === true || String(f.file_type) === "0",
      size: f.size || 0, fmt: String(f.obj_category || f.format_type || ""),
      // 转存要用：sharepage/save 必须给每条配对 (fid, share_fid_token)，缺一个就报 41020
      token: f.share_fid_token || "",
    })),
  };
}

async function shareList(url, pdir, passcode) {
  const d = await shareDetailFast(url, pdir, passcode);
  return d.items.map((x) => ({ fid: x.fid, filename: x.name, file_type: x.dir ? "0" : "1", size: x.size, token: x.token }));
}

async function walkShare(url, passcode, maxCalls = 14) {
  const vids = [];
  const queue = [{ fid: "0", depth: 0 }];
  let calls = 0;
  while (queue.length && calls < maxCalls && vids.length < 30) {
    const { fid, depth } = queue.shift();
    let files = [];
    try { files = await shareList(url, fid, passcode); } catch {}
    calls++;
    for (const f of files) {
      const isDir = String(f.file_type) === "0";
      if (isDir) { if (depth < 3) queue.push({ fid: f.fid, depth: depth + 1 }); }
      else if (/\.(mkv|mp4|ts|avi|mov|flv|wmv|webm|m2ts)$/i.test(f.filename || "")) vids.push(f);
    }
  }
  return vids;
}

// 体积偏好：优先选「不超过 PREFER_MAX_GB」的最大文件（画质与体积平衡），
// 全都超标时退而求其次选最小的；忽略 200MB 以下的样片/花絮。
const PREFER_MAX_GB = Number(process.env.PREFER_MAX_GB || 12);
function pickBySize(list) {
  const MIN = 200 * 1024 * 1024;
  const usable = list.filter((f) => (f.size || 0) >= MIN);
  const pool = usable.length ? usable : list;
  if (pool.length <= 1) return pool;
  const cap = PREFER_MAX_GB * 1024 * 1024 * 1024;
  const under = pool.filter((f) => (f.size || 0) <= cap);
  const chosen = under.length
    ? under.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a))
    : pool.reduce((a, b) => ((b.size || 0) < (a.size || 0) ? b : a));
  return [chosen, ...pool.filter((f) => f !== chosen)];
}

// 文件夹名清洗：去掉路径分隔符与非法字符，限长
function safeName(s) {
  return String(s)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2700}-\u{27BF}]/gu, " ")
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 32) || "未命名资源";
}
async function dirList(fid) {
  const r = await quarkApi("/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=" + fid + "&_page=1&_size=200&_fetch_total=1&_sort=file_type:asc,file_name:asc");
  return JSON.parse(r.text).data?.list || [];
}

async function rootList() {
  const r = await quarkApi("/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=0&_page=1&_size=200&_fetch_total=1");
  return JSON.parse(r.text).data?.list || [];
}

// 用网页接口直接新建文件夹：不依赖 CLI，也不需要系统里存在 node 可执行文件
async function createFolderApi(name, pdir = "0") {
  const r = await quarkApi("/1/clouddrive/file?pr=ucpro&fr=pc", {
    method: "POST",
    body: JSON.stringify({ pdir_fid: pdir, file_name: name, dir_path: "", dir_init_lock: false }),
  });
  const j = JSON.parse(r.text);
  if (j.code !== 0) throw new Error((j.message || "创建失败") + " (" + j.code + ")");
  return (j.data && j.data.fid) || null;
}

// 用网页接口转存整个分享：把根目录每一项连同它的 share_fid_token 一起提交，
// 夸克会连整个子目录树一起搬过去（和网页版「保存到网盘」是同一条链路）。
// 不依赖官方 CLI —— CLI 需要 OAuth 登录态，且靠环境变量识别调用方渠道，
// 双击启动的 App 里那些变量一个都不存在，CLI 会静默退出（0 输出、退出码 0）。
async function saveShareApi(url, passcode, toPdirFid) {
  const { pwdId, stoken } = await getStoken(url, passcode);
  const detail = await shareDetailFast(url, "0", passcode);
  const items = detail.items.filter((x) => x.token);
  if (!items.length) throw new Error("没读到可转存的内容（分享可能已失效）");
  const r = await quarkApi("/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc", {
    method: "POST",
    body: JSON.stringify({
      fid_list: items.map((x) => x.fid),
      fid_token_list: items.map((x) => x.token),
      to_pdir_fid: toPdirFid,
      pwd_id: pwdId,
      stoken,
      scene: "link",
      create_fid_list: [],
    }),
  });
  const j = JSON.parse(r.text);
  if (j.code !== 0) throw new Error((j.message || "转存失败") + " (" + j.code + ")");
  return (j.data && j.data.task_id) || null;
}

// 转存是异步任务：有 task_id 就等它跑完，失败要报出来而不是干等目录列表
async function waitSaveTask(taskId, { timeout = 120000 } = {}) {
  if (!taskId) return true;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    let j = null;
    try { j = JSON.parse((await quarkApi("/1/clouddrive/task?pr=ucpro&fr=pc&task_id=" + encodeURIComponent(taskId) + "&retry_index=0")).text); } catch { continue; }
    if (j.code !== 0) continue;
    const st = j.data && j.data.status;
    if (st === 2) return true;
    if (st === 3) throw new Error((j.data && j.data.message) || "转存任务失败");
  }
  return false;   // 超时不等于失败，交给调用方用目录列表兜底
}

async function dirFids(dirFid) {
  const r = await quarkApi("/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=" + dirFid + "&_page=1&_size=200&_fetch_total=1");
  return new Set((JSON.parse(r.text).data?.list || []).map((f) => f.fid));
}

async function runQuickPlay(job) {
  const t = (s) => { job.step = s; };
  await ensureSeed();
  // 目标：把「这条分享里的全部内容」原样转存进一个新文件夹，文件夹名 = 资源名。
  // 不做任何内容识别 —— 网盘资源普遍是多层文件夹、几百集混排、命名不规范，交给用户自己看。
  let url = null, passcode = null, entryTitle = null;
  if (job.shareUrl) {
    const m = String(job.shareUrl).match(/pwd=([A-Za-z0-9]+)/);
    url = String(job.shareUrl).split("?")[0];
    passcode = m ? m[1] : null;
    const r0 = await shareList(url, "0", passcode).catch(() => []);
    if (!r0.length) throw new Error("这条分享已失效或为空");
    job.shareTotal = r0.reduce((s2, f) => s2 + (f.size || 0), 0);
  } else if (job.href) {
    t("解析分享链接…");
    const r = await seed.resolveQuark(job.href);
    if (!r.url) throw new Error("分享链接解析失败（可能已失效）");
    url = r.url; passcode = r.pwd;
  } else {
    t("读取《" + job.title + "》的资源列表…");
    const d = await seed.detail(job.movieId);
    if (!d.quark.length) throw new Error("这部暂时没有夸克资源");
    const key = String(job.title || "").replace(/[（(【\[].*?[)）】\]]/g, "").replace(/\s+/g, "").trim();
    const cands = d.quark.slice(0, 10).sort((a, b) => {
      const am = key && String(a.title).includes(key) ? 1 : 0;
      const bm = key && String(b.title).includes(key) ? 1 : 0;
      return bm - am;
    });
    let dead = 0;
    for (let i = 0; i < cands.length; i++) {
      const e = cands[i];
      const r = await seed.resolveQuark(e.href).catch(() => ({ url: null }));
      if (!r.url) { dead++; continue; }
      t("检查第 " + (i + 1) + "/" + cands.length + " 条分享…（死链 " + dead + "）");
      const root = await shareList(r.url, "0", r.pwd).catch(() => []);
      if (!root.length) { dead++; continue; }
      url = r.url; passcode = r.pwd; entryTitle = e.title;
      job.shareTotal = root.reduce((s2, f) => s2 + (f.size || 0), 0);
      break;
    }
    if (!url) throw new Error("这部片子的 " + cands.length + " 条分享链接都失效了");
    job.entryTitle = entryTitle;
  }
  if (!url) throw new Error("没有可用的分享链接");
  // 新建一个以资源名命名的文件夹，把整个分享原样转存进去（保留原有的多层文件夹结构）
  const folderName = safeName(job.title || "未命名资源");
  // 已存在同名文件夹就直接复用（同一个剧反复转存不会堆出一堆「xxx (2)」）
  let root = await rootList();
  let folder = root.find((f) => f.file_name === folderName && f.file_type === 0);
  if (folder) {
    t("已存在文件夹「" + folderName + "」，转存进去…");
  } else {
    t("新建文件夹「" + folderName + "」…");
    await createFolderApi(folderName);
    root = await rootList();
    folder = root.find((f) => f.file_name === folderName && f.file_type === 0);
  }
  if (!folder) {
    // 夸克目录列表有延迟：刚建好的文件夹不一定立刻出现在 file/sort 里。
    // 之前直接判定失败，导致「文件夹其实建好了，却报创建失败」。重试几轮再判定。
    for (let i = 0; i < 8 && !folder; i++) {
      await new Promise((r) => setTimeout(r, 700));
      root = await rootList();
      folder = root.find((f) => f.file_name === folderName && f.file_type === 0);
    }
  }
  if (!folder) throw new Error("文件夹创建失败：" + folderName + "（重试 8 次仍未出现）");
  const folderFid = folder.fid;
  const sizeGB = (job.shareTotal || 0) / 1073741824;

  t("转存整个分享到「" + folderName + "」" + (sizeGB > 0.01 ? "（约 " + sizeGB.toFixed(1) + "GB）" : "") + "…");
  const taskId = await saveShareApi(url, passcode, folderFid);

  videosCache.at = 0;
  t("转存已提交，等待落盘…");
  const done = await waitSaveTask(taskId);
  if (!done) t("任务接口没给结果，改用目录列表确认…");
  const deadline = Date.now() + 120000;
  let count = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const list = await dirList(folderFid).catch(() => []);
    if (list.length) { count = list.length; break; }
  }
  if (!count) throw new Error("转存已提交，但 2 分钟内没看到内容，稍后点「刷新」再看");
  job.folderFid = folderFid;
  job.folderName = folderName;
  job.count = count;
  job.step = "完成";
  job.ok = true;
}

function startQuickPlay({ movieId, title, href, shareUrl }) {
  const id = newJob();
  const j = jobs.get(id);
  j.title = title || movieId || "资源";
  j.movieId = movieId;
  j.href = href;
  j.shareUrl = shareUrl;
  runQuickPlay(j).catch((e) => { j.ok = false; j.error = e?.message || String(e); j.step = "失败"; });
  return id;
}

/* ---------- 官方 CLI ---------- */
// 运行时已不再依赖 CLI（转存改走网页接口）。vendor/quarkclouddrive 留着手工排查用。

const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } }); });


/* ---------- 字幕：外挂字幕（同目录 / 字幕子目录里的 .srt / .ass / .vtt） ---------- */
// 夸克取字幕文本的路：file/info 拿父目录 → sort 列目录 → file/download 换直链 → 带完整 cookie 拉文本。
// 纯 fetch，不进浏览器热路径；编码识别 / SRT·ASS→WebVTT / 配对打分都在 subs.mjs（可单测）。
const subUrlCache = new Map();   // fid -> 直链（夸克直链约 12 分钟有效）
const subListCache = new Map();  // videoFid -> 同目录字幕清单

async function fileInfo(fid) {
  const r = await quarkApi("/1/clouddrive/file/info?pr=ucpro&fr=pc&fid=" + encodeURIComponent(fid));
  const j = JSON.parse(r.text);
  if (j.code !== 0 || !j.data) throw new Error(j.message || "取文件信息失败");
  return j.data;
}

async function fileDownUrl(fid) {
  const c = subUrlCache.get(fid);
  if (c && Date.now() - c.at < 12 * 60 * 1000) return c.url;
  const r = await quarkApi("/1/clouddrive/file/download?pr=ucpro&fr=pc", { method: "POST", body: JSON.stringify({ fids: [fid] }) });
  const j = JSON.parse(r.text);
  const url = j.data && j.data[0] && j.data[0].download_url;
  if (j.code !== 0 || !url) throw new Error(j.message || "取下载直链失败");
  subUrlCache.set(fid, { at: Date.now(), url });
  return url;
}

async function fetchFileBuf(fid) {
  const url = await fileDownUrl(fid);
  // 字幕文本也走 CDN：cookie 过期时同样 412，交给 cdnGet 自愈（顺手重换一条下载直链）
  const { r } = await cdnGet(url, undefined, async () => {
    subUrlCache.delete(fid);
    return await fileDownUrl(fid);
  });
  if (!r.ok) { subUrlCache.delete(fid); throw new Error("拉字幕失败 HTTP " + r.status); }
  return Buffer.from(await r.arrayBuffer());
}

async function listSubsFor(videoFid) {
  const c = subListCache.get(videoFid);
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.data;
  const info = await fileInfo(videoFid);
  const pdir = info.pdir_fid || "0";
  const items = await dirList(pdir);
  const subs = [], dirs = [];
  for (const f of items) {
    if (f.file_type === 0) { if (/(sub|字幕)/i.test(f.file_name || "")) dirs.push(f); }
    else if (SUBS_EXT.test(f.file_name || "")) subs.push(f);
  }
  // 有的资源整包字幕放在 Subs/ 之类的子目录里
  for (const d of dirs.slice(0, 3)) {
    try {
      for (const f of await dirList(d.fid)) {
        if (f.file_type !== 0 && SUBS_EXT.test(f.file_name || "")) { f.__in = d.file_name; subs.push(f); }
      }
    } catch {}
  }
  const data = {
    video: { fid: videoFid, name: info.file_name, pdir_fid: pdir },
    items: subs.map((f) => ({ fid: f.fid, name: f.file_name, size: f.size, dir: f.__in || "", lang: subLang(f.file_name), score: subScore(info.file_name, f.file_name) }))
      .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), "zh")),
  };
  data.auto = data.items.length && data.items[0].score >= 45 ? data.items[0].fid : null;
  subListCache.set(videoFid, { at: Date.now(), data });
  return data;
}


/* ---------- 内封字幕：只 Range 取 moov + 字幕样本，自己解 tx3g（不打包 ffmpeg） ---------- */
const rawPlayCache = new Map();     // fid -> video_list
const embedMoovCache = new Map();   // fid -> { tracks, buf, url }
const embedVttCache = new Map();    // fid|轨号|延迟 -> vtt

async function playList(fid) {
  const c = rawPlayCache.get(fid);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.list;
  const r = await quarkApi("/1/clouddrive/file/v2/play?pr=ucpro&fr=pc", { method: "POST", body: JSON.stringify({ fid }) });
  const j = JSON.parse(r.text);
  if (!j.data || !j.data.video_list) throw new Error(j.message || "无播放地址");
  rawPlayCache.set(fid, { at: Date.now(), list: j.data.video_list });
  return j.data.video_list;
}

async function fetchRange(url, start, end) {
  // 内封字幕要按几十路并发拉样本。cookie 过期时每路都会 412，但 healSession 是单飞的，
  // 只会重启一次浏览器；而且实测「新 cookie + 原地址」就能过（CDN 认 cookie 不认链接），所以原地重试即可。
  const { r } = await cdnGet(url, { Range: "bytes=" + start + "-" + end }, null);
  if (r.status !== 206 && r.status !== 200) throw new Error("拉取媒体失败 HTTP " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// moov 里才有字幕轨的采样表。夸克各档位的 moov_size / moov_behind 不一致，所以直接按盒头定位：
// 先看文件头，再看文件尾（moov 一般在头，也可能在尾）。命中的 moov 会缓存下来复用。
async function loadMoov(fid) {
  const c = embedMoovCache.get(fid);
  if (c && Date.now() - c.at < 20 * 60 * 1000) return c;
  return once("moov:" + fid, () => loadMoovOnce(fid));
}

async function loadMoovOnce(fid) {
  const list = await playList(fid);
  const cand = list.find((v) => v.video_info && v.video_info.url && !String(v.video_info.format || "").includes("m3u8")) || list[0];
  const vi = (cand && cand.video_info) || {};
  if (!vi.url) throw new Error("这个视频没有可直连的档位");
  const total = Number(vi.size) || 0;
  const head = await fetchRange(vi.url, 0, Math.min(65535, total ? total - 1 : 65535));
  const loc = locateMoovForward(head);
  let buf = null;
  if (loc && loc.start + loc.size <= head.length) buf = head.subarray(loc.start, loc.start + loc.size);
  else if (loc) buf = await fetchRange(vi.url, loc.start, loc.start + loc.size - 1);
  else if (total) {
    const tailLen = Math.min(total, 262144);
    const base = total - tailLen;
    const tail = await fetchRange(vi.url, base, total - 1);
    const l2 = locateMoovBackward(tail);
    if (!l2) throw new Error("文件里找不到 moov");
    buf = l2.start + l2.size <= tail.length ? tail.subarray(l2.start, l2.start + l2.size) : await fetchRange(vi.url, base + l2.start, base + l2.start + l2.size - 1);
  }
  if (!buf || buf.length < 16) throw new Error("定位 moov 失败");
  // 校验：某些档位的直链会返回签名过期的 XML（实测 super/low 档就是这样），别当成 MP4 硬解
  if (buf.toString("latin1", 4, 8) !== "moov") throw new Error("这个档位的直链取不到容器数据（返回的不是 MP4）");
  const all = parseTracks(buf, { start: 0, size: buf.length, body: 8 });
  if (!all.length) throw new Error("moov 里没解析出任何轨道");
  const tracks = all.filter((t) => SUB_HANDLERS.has(t.handler) && /tx3g|text|wvtt/.test(t.format));
  const rec = { at: Date.now(), buf, url: vi.url, tracks, rendition: cand.resolution || "" };
  embedMoovCache.set(fid, rec);
  if (embedMoovCache.size > 3) embedMoovCache.delete(embedMoovCache.keys().next().value);
  return rec;
}

async function embeddedTracks(fid) {
  const m = await loadMoov(fid);
  return { rendition: m.rendition, tracks: m.tracks.map((t, i) => ({ index: i, lang: t.language || "", fmt: t.format, samples: t.sampleCount, source: t.handler })) };
}

// 字幕样本散落在整个文件里（实测中位间隔 2.5MB）——只能并发拉，串行会跑成几分钟。
// 并发 32 实测 1828 段约 6 秒；解出来的 VTT 会落盘缓存，同一集第二次播放秒开。
// 同一个视频的提取串行 + 同 key 去重：连点两集会互相抢带宽，也会把普通接口挤到 fetch failed
const inflight = new Map();
function once(key, fn) {
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchRanges(url, ranges, concurrency = 24) {
  const out = new Array(ranges.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ranges.length) {
      const i = cursor++;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { out[i] = { start: ranges[i].start, end: ranges[i].end, buf: await fetchRange(url, ranges[i].start, ranges[i].end) }; break; }
        catch (e) { out[i] = null; if (attempt < 2) await new Promise((rr) => setTimeout(rr, 200 * (attempt + 1))); }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ranges.length)) }, worker));
  return out.filter(Boolean);
}

const SUBCACHE_DIR = path.join(DATA_DIR, "subcache");
async function embeddedVttBase(fid, index) {
  const key = fid + "|" + index;
  const hit = embedVttCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.vtt;
  return once("vtt:" + key, () => embeddedVttOnce(fid, index, key));
}

async function embeddedVttOnce(fid, index, key) {
  const file = path.join(SUBCACHE_DIR, fid + "-" + index + ".vtt");
  try { if (fs.existsSync(file)) { const vtt = fs.readFileSync(file, "utf8"); embedVttCache.set(key, { at: Date.now(), vtt }); return vtt; } } catch {}
  const m = await loadMoov(fid);
  const t = m.tracks[index];
  if (!t) throw new Error("没有第 " + (index + 1) + " 条内封字幕轨");
  const offs = sampleOffsets(t), times = sampleTimes(t);
  const specs = offs.map((s, i) => ({ offset: s.offset, size: s.size, start: times[i] ? times[i].start : 0, dur: times[i] ? times[i].dur : 0 }));
  const ranges = mergeRanges(specs);
  const t0 = Date.now();
  const fetched = await fetchRanges(m.url, ranges);
  if (!fetched.length) throw new Error("内封字幕样本拉取失败");
  const cues = [];
  for (const s of specs) {
    if (!s.size) continue;
    const b = sliceSample(fetched, s);
    if (!b) continue;
    const txt = decodeTx3g(b);
    if (!txt) continue;
    cues.push({ a: s.start, b: s.start + s.dur, txt });
  }
  const vtt = cuesToVtt(cues, 0);
  console.log("[sub] 内封字幕 fid=" + fid.slice(0, 8) + " 轨=" + index + " 样本=" + specs.length + " 段=" + ranges.length + " 文本=" + cues.length + " 条 用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  try { fs.mkdirSync(SUBCACHE_DIR, { recursive: true }); fs.writeFileSync(file, vtt); } catch {}
  embedVttCache.set(key, { at: Date.now(), vtt });
  if (embedVttCache.size > 60) embedVttCache.delete(embedVttCache.keys().next().value);
  return vtt;
}

async function embeddedVtt(fid, index, delay = 0) {
  return shiftVtt(await embeddedVttBase(fid, index), delay);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const started = Date.now();
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") {
      // 界面改动要"刷新即生效"：显式禁缓存，否则无缓存头时浏览器会启发式缓存旧页面
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(ROOT, "public", "index.html")));
    }
    if (u.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (u.pathname === "/hls.min.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "max-age=86400" });
      return res.end(fs.readFileSync(path.join(ROOT, "public", "hls.min.js")));
    }
    if (u.pathname === "/api/health") {
      const h = { server: "ok", version: BUILD.version, cookieOK: !!cookieHeader(), cookieAt: cookieCache.at ? new Date(cookieCache.at).toLocaleTimeString() : null, videoCount: videosCache.list.length, cachedAt: videosCache.at ? new Date(videosCache.at).toLocaleTimeString() : null, playCached: playCache.size };
      if (!cookieHeader()) h.hint = "夸克网盘登录态不可用：点界面上的「重新登录夸克」重新登录";
      return json(res, 200, h);
    }
    if (u.pathname === "/api/version") {
      return json(res, 200, Object.assign({}, BUILD, { versionLine: versionLine(BUILD), dataDir: DATA_DIR, root: ROOT }));
    }
    if (u.pathname === "/api/account") {
      // 「当前登录的是谁」：优先问夸克要昵称，拿不到就退回 __uid。
      // 界面靠它显示账户，也是「切换账户」前的判断依据。
      if (!cookieHeader()) await refreshCookies();
      const jar = cookieHeader() || "";
      const uid = (jar.match(/(?:^|;\s*)__uid=([^;]+)/) || [])[1] || null;
      if (!jar) return json(res, 200, { loggedIn: false, uid: null, nickname: null });
      let info = null;
      try {
        const r = await quarkApi("/1/clouddrive/member?pr=ucpro&fr=pc&fetch_subscribe=true&_ch=home&uc_param_str=");
        const j = JSON.parse(r.text);
        if (j && j.data) info = j.data;
      } catch (e) { /* 拿不到就当没有，不影响登录状态判断 */ }
      const nick = info && (info.nickname || info.nick_name) ? (info.nickname || info.nick_name) : null;
      return json(res, 200, {
        loggedIn: true,
        uid,
        nickname: nick,
        memberType: info ? (info.member_type ?? null) : null,
        display: nick || (uid ? "uid " + String(uid).slice(0, 8) + "…" : "已登录（读不到账户信息）"),
      });
    }
    if (u.pathname === "/api/search") {
      const q = (u.searchParams.get("q") || "").trim();
      if (!q) return json(res, 400, { error: "q required" });
      const idx = loadIndex();
      if (!idx) return json(res, 200, { q, count: 0, items: [], indexing: true, hint: "索引尚未建好，先点「重建索引」" });
      // 分词匹配：多个词之间是「都要包含」而不是「连在一起」
      // 否则搜「斗破苍穹 第一季」会因为中间一个空格而漏掉 「斗破苍穹之大主宰 第一季」
      const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
      const norm = (s) => String(s || "").toLowerCase().replace(/[\s·・\-_/]/g, "");
      let hits = idx.items.filter((it) => {
        const t = norm(it.title);
        return tokens.every((tk) => t.includes(norm(tk)));
      });
      let live = false;
      if (!hits.length) {
        // 兜底：本地索引没命中，现场抓最近 16 页比对（新片往往还没进索引）
        try {
          await ensureSeed();
          const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => seed.listPage(i + 1).catch(() => ({ items: [] }))));
          const liveMap = new Map();
          for (const r of rs) for (const it of r.items || []) liveMap.set(it.id, it);
          hits = [...liveMap.values()].filter((it) => { const t = norm(it.title); return tokens.every((tk) => t.includes(norm(tk))); });
          live = true;
        } catch {}
      }
      return json(res, 200, { q, count: hits.length, live, indexCount: idx.count, builtAt: idx.builtAt, items: hits.slice(0, 100) });
    }
    if (u.pathname === "/api/index/status") {
      const idx = loadIndex();
      return json(res, 200, idx ? { ready: true, count: idx.count, builtAt: idx.builtAt, building: !!refreshingIdx } : { ready: false });
    }
    if (u.pathname === "/api/index/refresh" && req.method === "POST") {
      const n = await refreshRecent(Number(u.searchParams.get("pages") || 30));
      return json(res, 200, { ok: true, count: n });
    }
    if (u.pathname === "/api/b/relogin") {
      const wait = u.searchParams.get("wait") === "1";
      const st = doRelogin();
      // wait=1：最多等 20 秒，方便脚本/测试；界面走轮询
      if (!wait) return json(res, 200, st);
      const t0 = Date.now();
      while (relogin.running && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 500));
      return json(res, 200, relogin);
    }
    if (u.pathname === "/api/b/relogin/status") return json(res, 200, relogin);
    if (u.pathname === "/api/q/relogin") {
      const wait = u.searchParams.get("wait") === "1";
      const st = doQuarkRelogin();
      if (!wait) return json(res, 200, st);
      const t0 = Date.now();
      while (qRelogin.running && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 500));
      return json(res, 200, qRelogin);
    }
    if (u.pathname === "/api/q/relogin/status") return json(res, 200, qRelogin);
    if (u.pathname === "/api/q/switch-account" && req.method === "POST") {
      // 换账号 = 先把这个 profile 里的夸克会话清掉，再走一遍登录流程。
      // 不清的话，再打开夸克页面会直接是"已登录"状态，用户根本没有输入另一个账号的机会。
      if (qRelogin.running) return json(res, 409, { error: "上一次登录还没结束，等它跑完再切" });
      try {
        await closeQuarkCtx();
        await new Promise((r) => setTimeout(r, 800));
        const tmp = await chromium.launchPersistentContext(PROFILE, { channel: "msedge", headless: true, locale: "zh-CN" });
        try { await tmp.clearCookies(); } catch (e) {}
        await tmp.close();
      } catch (e) {
        return json(res, 500, { error: "清登录态失败：" + ((e && e.message) || String(e)) });
      } finally {
        await closeQuarkCtx();
      }
      cookieCache = { at: 0, value: "", ok: false };
      try { fs.unlinkSync(COOKIE_FILE); } catch (e) {}
      const st = doQuarkRelogin();
      return json(res, 200, Object.assign({ switched: true }, st));
    }
    if (u.pathname === "/api/b/search") {
      const q = (u.searchParams.get("q") || "").trim();
      if (!q) return json(res, 400, { error: "q required" });
      const mode = Number(u.searchParams.get("mode") || 1);
      const pages = Math.min(40, Math.max(1, Number(u.searchParams.get("pages") || 2)));
      try {
        const r = await withTimeout(bSearchCached(q, mode, pages), 120000, "站点 B 响应超时（120 秒），多半是人机验证卡住了，稍后再试或重新登录");
        return json(res, 200, { q, mode, pages, ...r });
      } catch (e) {
        return json(res, 200, { q, mode, pages, counts: null, total: 0, items: [], error: e.message || String(e) });
      }
    }
    if (u.pathname === "/api/check" && req.method === "POST") {
      const body = await readBody(req);
      const urls = (Array.isArray(body.urls) ? body.urls : []).filter(Boolean).slice(0, 200);
      if (!urls.length) return json(res, 400, { error: "urls required" });
      const results = await checkMany(urls, 4);
      const alive = Object.values(results).filter((r) => r.ok === true).length;
      const dead = Object.values(results).filter((r) => r.ok === false).length;
      return json(res, 200, { total: urls.length, alive, dead, results });
    }
    if (u.pathname === "/api/b/pan") {
      const sb = await ensureSiteB();
      const r = await sb.panList(u.searchParams.get("kind") || "mv", u.searchParams.get("id"));
      return json(res, 200, r);
    }
    if (u.pathname === "/api/quark") {
      await ensureSeed();
      const d = await seed.detail(u.searchParams.get("movie"));
      return json(res, 200, { movie: u.searchParams.get("movie"), count: d.quark.length, items: d.quark.slice(0, 60) });
    }
    if (u.pathname === "/api/resolve") {
      await ensureSeed();
      return json(res, 200, await seed.resolveQuark(u.searchParams.get("href")));
    }
    if (u.pathname === "/api/quickplay" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.movie && !body.href && !body.shareUrl) return json(res, 400, { error: "movie / href / shareUrl 三选一" });
      const id = startQuickPlay({ movieId: body.movie, title: body.title, href: body.href, shareUrl: body.shareUrl });
      return json(res, 200, { jobId: id });
    }
    if (u.pathname === "/api/quickplay/status") {
      const j = jobs.get(u.searchParams.get("id"));
      if (!j) return json(res, 404, { error: "no such job" });
      return json(res, 200, { id: j.id, step: j.step, ok: j.ok, error: j.error, warn: j.warn, entryTitle: j.entryTitle, folderFid: j.folderFid, folderName: j.folderName, count: j.count, shareTotal: j.shareTotal });
    }
    // 批量查「分享里每个子文件夹有多少个条目」——预览时给每个文件夹标注
    if (u.pathname === "/api/share/counts" && req.method === "POST") {
      const body = await readBody(req);
      const url = body.url;
      const passcode = body.passcode || "";
      const fids = (Array.isArray(body.fids) ? body.fids : []).filter(Boolean).slice(0, 80);
      if (!url || !fids.length) return json(res, 400, { error: "url/fids required" });
      const counts = {};
      const queue = fids.slice();
      async function worker() {
        while (queue.length) {
          const fid = queue.shift();
          try { counts[fid] = await shareFolderCount(url, fid, passcode); }
          catch (e) { counts[fid] = null; }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, fids.length) }, worker));
      return json(res, 200, { counts });
    }
    // 预览分享内容（转存之前先看看里面有什么，支持逐层下钻）
    if (u.pathname === "/api/share") {
      const href = u.searchParams.get("href");
      const direct = u.searchParams.get("url");
      const pdir = u.searchParams.get("pdir") || "0";
      let rec = null;
      if (direct) {
        const m = String(direct).match(/pwd=([A-Za-z0-9]+)/);
        rec = { url: String(direct).split("?")[0], passcode: m ? m[1] : null, at: Date.now() };
      } else {
        if (!href) return json(res, 400, { error: "href or url required" });
        rec = shareUrlCache.get(href);
        if (!rec || Date.now() - rec.at > 30 * 60 * 1000) {
          await ensureSeed();
          const r = await seed.resolveQuark(href);
          if (!r.url) return json(res, 410, { error: "分享链接解析失败（可能已失效）" });
          rec = { url: r.url, passcode: r.pwd, at: Date.now() };
          shareUrlCache.set(href, rec);
        }
      }
      const d = await shareDetailFast(rec.url, pdir, rec.passcode).catch(() => ({ items: [], total: null }));
      return json(res, 200, {
        url: rec.url, pdir, total: d.total,
        allFiles: d.allFiles, fileSize: d.size, videoTotal: d.videoTotal, shareTitle: d.title,
        folders: d.items.filter((x) => x.dir).length,
        files: d.items.filter((x) => !x.dir).length,
        items: d.items,
      });
    }
    if (u.pathname === "/api/delete" && req.method === "POST") {
      const body = await readBody(req);
      const fids = Array.isArray(body.fids) ? body.fids : [];
      if (!fids.length) return json(res, 400, { error: "fids required" });
      const r = await quarkApi("/1/clouddrive/file/delete?pr=ucpro&fr=pc", {
        method: "POST",
        body: JSON.stringify({ action_type: 2, exclude_fids: [], filelist: fids }),
      });
      let j = {};
      try { j = JSON.parse(r.text); } catch {}
      videosCache.at = 0;
      return json(res, j.code === 0 ? 200 : 500, { ok: j.code === 0, message: j.message || r.text.slice(0, 140), count: fids.length });
    }
    if (u.pathname === "/api/list") {
      const pdir = u.searchParams.get("pdir_fid") || "0";
      const list = await dirList(pdir);
      return json(res, 200, { pdir_fid: pdir, items: list.map((f) => ({ fid: f.fid, name: f.file_name, dir: f.file_type === 0, size: f.size, fmt: f.format_type })) });
    }
    if (u.pathname === "/api/videos") {
      const force = u.searchParams.get("force") === "1";
      const out = await listVideos(force);
      return json(res, 200, { videos: out, cachedAt: videosCache.at, fromCache: !force && Date.now() - videosCache.at < CACHE_MS });
    }
    if (u.pathname === "/api/play") {
      const rec = await getPlayUrl(u.searchParams.get("fid"), u.searchParams.get("res"));
      return json(res, 200, { name: rec.name, resolutions: rec.resolutions });
    }
    if (u.pathname === "/api/media") {
      const fid = u.searchParams.get("fid");
      const wantRes = u.searchParams.get("res");
      const rec = await getPlayUrl(fid, wantRes);
      const q = rec.kind === "hls" && wantRes ? "?res=" + encodeURIComponent(wantRes) : "";
      return json(res, 200, {
        fid, name: rec.name, kind: rec.kind, format: rec.format, size: rec.size,
        current: rec.current, width: rec.width, height: rec.height, bitrate: rec.bitrate,
        resolutions: rec.resolutions,
        embedded: rec.embedded || [],
        src: rec.kind === "hls" ? "/play/" + encodeURIComponent(fid) + "/index.m3u8" + q : "/file/" + encodeURIComponent(fid),
      });
    }
    if (u.pathname === "/api/subs") {
      const fid = u.searchParams.get("fid");
      if (!fid) return json(res, 400, { error: "缺 fid" });
      return json(res, 200, await listSubsFor(fid));
    }
    if (u.pathname === "/api/sub") {
      const sFid = u.searchParams.get("fid");
      if (!sFid) return json(res, 400, { error: "缺 fid" });
      const name = u.searchParams.get("name") || "";
      const ext = (u.searchParams.get("ext") || name.split(".").pop() || "").toLowerCase();
      const delay = Number(u.searchParams.get("delay") || 0) || 0;
      const buf = await fetchFileBuf(sFid);
      const vtt = toVtt(decodeSubText(buf), ext, delay);
      res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      return res.end(vtt);
    }
    if (u.pathname === "/api/embedded") {
      const fid = u.searchParams.get("fid");
      if (!fid) return json(res, 400, { error: "缺 fid" });
      return json(res, 200, await embeddedTracks(fid));
    }
    if (u.pathname === "/api/embed.vtt") {
      const fid = u.searchParams.get("fid");
      if (!fid) return json(res, 400, { error: "缺 fid" });
      const i = Number(u.searchParams.get("i") || 0) || 0;
      const delay = Number(u.searchParams.get("delay") || 0) || 0;
      const vtt = await embeddedVtt(fid, i, delay);
      res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      return res.end(vtt);
    }
    if (u.pathname.startsWith("/file/")) {
      const fid = decodeURIComponent(u.pathname.slice("/file/".length));
      const resParam = u.searchParams.get("res");
      let rec = await getPlayUrl(fid, resParam);
      if (rec.kind === "hls") { res.writeHead(302, { Location: "/play/" + encodeURIComponent(fid) + "/index.m3u8" }); return res.end(); }
      const range = req.headers.range || "bytes=0-";
      const got = await cdnGet(rec.url, { Range: range }, async () => {
        playCache.delete(fid + "|" + (resParam || "best"));   // 旧地址可能绑在旧会话上，重取
        rec = await getPlayUrl(fid, resParam);
        return rec.url;
      });
      const up = got.r;
      const h = { "Content-Type": up.headers.get("content-type") || "application/octet-stream", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
      const cl = up.headers.get("content-length"); if (cl) h["Content-Length"] = cl;
      const cr = up.headers.get("content-range"); if (cr) h["Content-Range"] = cr;
      res.writeHead(up.status, h);
      if (!up.body) return res.end();
      const stream = Readable.fromWeb(up.body);
      stream.on("error", () => { try { res.destroy(); } catch {} });
      stream.pipe(res);
      return;
    }
    if (u.pathname.startsWith("/play/") && u.pathname.endsWith("/index.m3u8")) {
      const fid = u.pathname.split("/")[2];
      const wantRes = u.searchParams.get("res");
      let rec = await getPlayUrl(fid, wantRes);
      const got = await cdnGet(rec.url, undefined, async () => {
        playCache.delete(fid + "|" + (wantRes || "best"));
        rec = await getPlayUrl(fid, wantRes);
        return rec.url;
      });
      const r = got.r;
      if (!r.ok) throw new Error("上游 m3u8 " + r.status);
      let body = await r.text();
      const base = got.url.slice(0, got.url.lastIndexOf("/") + 1);
      rec.base = base;
      playCache.set(fid + "|seg", { at: Date.now(), base });
      body = body.split("\n").map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (m, p1) => 'URI="/play/' + fid + '/seg?u=' + encodeURIComponent(p1) + '"');
        return "/play/" + fid + "/seg?u=" + encodeURIComponent(t);
      }).join("\n");
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      return res.end(body);
    }
    if (u.pathname.startsWith("/play/") && u.pathname.endsWith("/seg")) {
      const fid = u.pathname.split("/")[2];
      const rec = playCache.get(fid + "|seg") || playCache.get(fid + "|best");
      if (!rec) return json(res, 404, { error: "no session" });
      const target = new URL(u.searchParams.get("u"), rec.base).href;
      const range = req.headers.range;
      // 分片地址是签名好的绝对地址，重解析要整个 m3u8 —— 这里自愈后原地址重试一次即可
      const up = (await cdnGet(target, range ? { Range: range } : {}, null)).r;
      const h = { "Content-Type": up.headers.get("content-type") || "video/mp2t", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" };
      const cr = up.headers.get("content-range"); if (cr) h["Content-Range"] = cr;
      const cl = up.headers.get("content-length"); if (cl) h["Content-Length"] = cl;
      res.writeHead(up.status, h);
      if (!up.body) return res.end();
      // 流式转发：边收边发，不再等整段缓冲完
      const st = Readable.fromWeb(up.body);
      st.on("error", () => { try { res.destroy(); } catch {} });
      return st.pipe(res);
    }
    json(res, 404, { error: "not found", path: u.pathname });
  } catch (e) {
    console.error("[err] " + u.pathname + " " + (e?.message || e) + " (" + (Date.now() - started) + "ms)");
    json(res, 500, { error: e?.message || String(e) });
  }
});

let listenIdx = 0, listening = false;
server.on("error", (e) => {
  if (listening) { console.error("[server] 服务运行期错误：" + (e.code || e.message)); return; }
  console.error("[server] 端口 " + PORT_LIST[listenIdx] + " 不可用（" + (e.code || e.message) + "）" + (listenIdx + 1 < PORT_LIST.length ? "，自动换 " + PORT_LIST[listenIdx + 1] : ""));
  start(listenIdx + 1);
});
function start(i = 0) {
  if (i >= PORT_LIST.length) {
    console.error("[server] 候选端口全部不可用（" + PORT_LIST.join(", ") + "）。多半都在 Windows 保留段内：重启机器通常能释放，或用 PORT=端口 指定一个范围外的。");
    process.exit(1);
  }
  listenIdx = i;
  const p = PORT_LIST[i];
  // listen(port, host, cb) 每次调用都会把 cb 追加成 listening 监听器；
  // 换端口重试前必须清掉旧的，否则成功后旧回调（带着旧端口的闭包）也会跑一遍
  server.removeAllListeners("listening");
  server.listen(p, "127.0.0.1", () => {
    listening = true;
    console.log("listening on http://127.0.0.1:" + p + (i > 0 ? "（" + PORT_LIST[0] + " 被系统保留或占用，已自动换端口）" : ""));
    try { fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true }); fs.writeFileSync(PORT_FILE, String(p)); } catch {}
    (async () => {
      if (loadCookieFile()) console.log("[cookie] 载入磁盘缓存");
      else { console.log("[cookie] 无缓存，正在从浏览器读取…"); await refreshCookies(); }
      listVideos(true).then((v) => console.log("[videos] 预热完成 " + v.length + " 个")).catch((e) => console.error("[videos] " + e.message));
      // 站点 A（SeedHub）已从界面移除，不再定时抓索引。需要时手动调 /api/index/refresh。
      if (process.env.KEEP_SEED_INDEX === "1") {
        setTimeout(() => refreshRecent(30), 20000);
        setInterval(() => refreshRecent(30), 30 * 60 * 1000);
      }
    })();
  });
}
start();
