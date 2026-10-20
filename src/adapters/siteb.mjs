// 站点 B（hgeme.com / 挂了👻 镜像）适配器
// 需要登录态（data/siteb-profile），站点有 PoW 人机验证，必须用真浏览器。
//
// 关键接口：
//   网盘搜索：GET /search?q=<关键词>&type=5&mode=<1模糊|2适中|3精准>
//     —— 结果页里每个命中网盘域名的 <a href> 就是明文分享链接；页首有各分类计数
//   某资源页的全部分享：GET /res/downurl/<mv|tv|ac>/<id> -> JSON.panlist（列式数组）
//     panlist.tname = ["迅雷网盘","百度网盘","夸克网盘","123网盘","UC网盘","阿里网盘","光鸭网盘"]
//     panlist.type[i] 为 tname 下标；panlist.url[i] 为分享链接

const BASE = "https://www.hgeme.com";
export const NETDISK_NAMES = ["迅雷网盘", "百度网盘", "夸克网盘", "123网盘", "UC网盘", "阿里网盘", "光鸭网盘"];
export const PAN_HOSTS = ["pan.quark.cn", "pan.xunlei.com", "pan.baidu.com", "www.aliyundrive.com", "www.alipan.com", "cloud.189.cn", "caiyun.139.com", "pan.123pan.com", "www.123pan.com", "drive.uc.cn"];

// 人机验证页 / 登录墙的判定（导航途中 title 会瞬时为空或旧值，所以判定要 title + 正文双重确认）
const VERIFY_RE = /安全验证|浏览器安全验证|正在验证|正在提交结果|Just a moment|Checking your browser/i;
const LOGIN_RE = /未登录|登录后访问受限|请先登录|请登录后继续/;

// 「今天 / 3天前 / 2025-12-18」→ 大约几天前（用于排序）
function daysFrom(label) {
  const s = String(label);
  if (/今天|分钟前|小时前/.test(s)) return 0;
  if (s === "昨天") return 1;
  if (s === "前天") return 2;
  let m;
  if ((m = s.match(/^(\d+)\s*天前$/))) return Number(m[1]);
  if ((m = s.match(/^(\d+)\s*周前$/))) return Number(m[1]) * 7;
  if ((m = s.match(/^(\d+)\s*个月前$/))) return Number(m[1]) * 30;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
  }
  return null;
}

export class SiteB {
  constructor({ browser, base = BASE } = {}) { this.browser = browser; this.base = base; this.page = null; }

  async ensure() {
    if (!this.page) {
      const b = this.browser;
      if (typeof b.newContext === "function") {
        const ctx = await b.newContext({ locale: "zh-CN" });
        this.page = await ctx.newPage();
      } else {
        const pages = b.pages();
        this.page = pages[0] || (await b.newPage());
      }
    }
    return this.page;
  }

  /** 等人机验证过去。导航中途 title 会瞬时为空/旧值，只靠 title 判断会误判成「已通过」，
   *  然后 evaluate 撞上导航 -> Execution context was destroyed。这里改成 title+正文双确认，
   *  并且所有取数都在导航异常下重试。 */
  async _waitReady(page, { timeout = 20000 } = {}) {
    const t0 = Date.now();
    let title = "", wall = false;
    while (Date.now() - t0 < timeout) {
      try { title = (await page.title()) || ""; } catch (e) { await page.waitForTimeout(400); continue; }
      if (title.trim() && !VERIFY_RE.test(title)) {
        let body = "";
        try { body = await page.evaluate(() => (document.body ? document.body.innerText : "").slice(0, 400)); }
        catch (e) { await page.waitForTimeout(400); continue; }   // 正在导航，下一轮再看
        if (body && !VERIFY_RE.test(body)) {
          wall = LOGIN_RE.test(title) || LOGIN_RE.test(body);
          return { ok: true, title, wall };
        }
      }
      await page.waitForTimeout(400);
    }
    return { ok: false, title, wall };
  }

  /** 跨导航重试 evaluate：验证刚过的一瞬间页面还在跳，evaluate 会抛「上下文被销毁」 */
  async _extract(page, fn, arg, { tries = 5 } = {}) {
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      try { return await page.evaluate(fn, arg); }
      catch (e) { lastErr = e; await page.waitForTimeout(700); }
    }
    throw lastErr || new Error("页面取值失败");
  }

  /** 预热：把「搜索页」真正跑通一次（首页不卡登录墙，搜索页才会），
   *  验证 + 结果列表都就绪才算成功。重新登录之后调用。 */
  async warmup({ tries = 3 } = {}) {
    for (let i = 0; i < tries; i++) {
      const page = await this.ensure();
      try {
        await page.goto(this.base + "/search?q=" + encodeURIComponent("测试") + "&type=5&mode=1", { waitUntil: "domcontentloaded", timeout: 60000 });
        const r = await this._waitReady(page);
        if (r.ok && !r.wall) {
          const dl = Date.now() + 12000;
          while (Date.now() < dl) {
            let n = 0;
            try { n = await page.evaluate(() => document.querySelectorAll("a[href]").length); } catch (e) {}
            if (n > 0) return true;
            await page.waitForTimeout(500);
          }
        }
      } catch (e) {}
      await page.waitForTimeout(1200);
    }
    return false;
  }

  async _goto(path) {
    const page = await this.ensure();
    await page.goto(this.base + path, { waitUntil: "domcontentloaded", timeout: 60000 });
    await this._waitReady(page);
    return page;
  }

  /** 在指定页面上做一次搜索 */
  async _searchOn(page$, q, { type = 5, mode = 1, page = 1 } = {}) {
    const enc = encodeURIComponent(q);
    {
      const target = this.base + "/search?q=" + enc + "&type=" + type + "&mode=" + mode + (page > 1 ? "&page=" + page : "");
      await page$.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
      const ready = await this._waitReady(page$);
      if (!ready.ok) return { counts: null, total: 0, items: [], empty: true, error: "站点 B 的人机验证没能在 20 秒内通过", verifyStuck: true };
      if (ready.wall) return { counts: null, total: 0, items: [], empty: true, error: "站点 B 登录态已失效，需要重新登录" };
      // 结果页由 Vue 渲染，等列表挂上来再抽，否则会抓到空壳
      const dl = Date.now() + 12000;
      while (Date.now() < dl) {
        let n = 0;
        try { n = await page$.evaluate(() => document.querySelectorAll("a[href]").length); } catch (e) {}
        if (n > 0) break;
        await page$.waitForTimeout(500);
      }
      const data = await this._extract(page$, (hosts) => {
        const PAN = new RegExp("^https?://(" + hosts.map((h) => h.replace(/\./g, "\\.")).join("|") + ")/", "i");
        const out = [];
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.getAttribute("href") || "";
          if (!PAN.test(href)) return;
          let el = a;
          for (let i = 0; i < 7 && el.parentElement; i++) {
            el = el.parentElement;
            const t = (el.innerText || "").replace(/\s+/g, " ").trim();
            if (/网盘/.test(t) && t.length > 15 && t.length < 600) break;
          }
          out.push({ url: href.replace(/#$/, ""), text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400) });
        });
        const cnt = [...document.querySelectorAll(".search_head .l a")].map((x) => x.textContent.trim());
        return { out, cnt };
      }, PAN_HOSTS);
      let counts = null, total = 0;
      if (data.cnt && data.cnt.length) {
        counts = data.cnt;
        const m = data.cnt.find((c) => c.includes("网盘"));
        total = m ? Number((m.match(/(\d+)/) || [])[1] || 0) : 0;
      }
      const seen = new Set();
      const items = data.out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))).map((r) => {
        const netdisk = NETDISK_NAMES.find((n) => r.text.startsWith(n)) || NETDISK_NAMES.find((n) => r.text.includes(n)) || "未知";
        let rest = r.text.replace(netdisk, "").replace(/\s+/g, " ").trim();
        // 行尾是「分享时间」，再往前一格通常是「分享者」——拆出来单独用
        let timeLabel = "", daysAgo = null;
        const tm = rest.match(/(今天|昨天|前天|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d+\s*周前|\d+\s*个月前|\d{4}-\d{1,2}-\d{1,2})\s*$/);
        if (tm) {
          timeLabel = tm[1].replace(/\s+/g, "");
          daysAgo = daysFrom(timeLabel);
          rest = rest.slice(0, rest.length - tm[0].length).trim();
        }
        let user = "";
        const um = rest.match(/\s+([^\s【】\[\]（）()]{1,14})$/);
        if (um && !/[【】\[\]（）()]/.test(um[1])) { user = um[1]; rest = rest.slice(0, rest.length - um[0].length).trim(); }
        return { url: r.url, netdisk, name: rest.slice(0, 130), user, time: timeLabel, daysAgo };
      });
      return { counts, total, items, empty: items.length === 0 };
    }
  }

  /** 单页搜索（走常驻页面） */
  async searchPage(q, opts = {}) {
    const pg = await this.ensure();
    return this._searchOn(pg, q, opts);
  }

  /** 多页并发搜索（最多 3 个标签页），把 3.6 秒的等待压到 1.5 秒左右 */
  async searchPages(q, { pages = 2, concurrency = 3, ...rest } = {}) {
    const pg = await this.ensure();
    const ctx = pg.context();
    const queue = Array.from({ length: pages }, (_, i) => i + 1);
    const results = new Array(pages);
    const workers = Array.from({ length: Math.min(concurrency, pages) }, async () => {
      const tab = await ctx.newPage();
      try {
        while (queue.length) {
          const p = queue.shift();
          let r = await this._searchOn(tab, q, { ...rest, page: p });
          // 人机验证卡住时重试同一个页面没意义（浏览器状态已经坏了），交给上层重开浏览器
          if (r && r.error && !r.verifyStuck) { await tab.waitForTimeout(900); r = await this._searchOn(tab, q, { ...rest, page: p }); }
          results[p - 1] = r;
        }
      } catch (e) {
        while (queue.length) { const p = queue.shift(); results[p - 1] = { counts: null, total: 0, items: [], empty: true, error: e.message }; }
      } finally { await tab.close().catch(() => {}); }
    });
    await Promise.all(workers);
    return results;
  }

  /** 网盘搜索：多页合并（保留旧签名） */
  async search(q, { type = 5, mode = 1, maxPages = 2 } = {}) {
    const rows = [];
    let counts = null, total = 0;
    for (let p = 1; p <= maxPages; p++) {
      const r = await this.searchPage(q, { type, mode, page: p });
      if (!counts && r.counts) { counts = r.counts; total = r.total; }
      if (r.empty) break;
      rows.push(...r.items);
    }
    const seen = new Set();
    return { counts, total, items: rows.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true))) };
  }

  /** 某资源页的全部分享（把列式 panlist 展开成行） */
  async panList(kind, id) {
    const page = await this._goto("/" + kind + "/" + id);
    const j = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: "include" }); return await r.json(); }, "/res/downurl/" + kind + "/" + id);
    const p = j && j.panlist;
    if (!p || !p.id) return { items: [], magnetCount: 0, playCount: 0 };
    const tname = p.tname || NETDISK_NAMES;
    const items = p.id.map((_, i) => ({
      url: String(p.url[i] || "").replace(/#$/, ""),
      name: p.name[i] || "",
      netdisk: tname[p.type[i]] || "未知",
      user: p.user[i] || "",
      time: p.time[i] || "",
    })).filter((x) => x.url);
    return { items, magnetCount: ((j.downlist || {}).list || {}).m ? j.downlist.list.m.length : 0, playCount: (j.playlist || []).length };
  }
}
