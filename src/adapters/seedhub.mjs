// SeedHub 资源站适配器（seedog.cc 及其镜像）
// 实测结论：资源页的夸克条目带 data-link="pan.quark.cn"，
// 点进 /link_start/?redirect_to=pan_id_XXX 后，分享链接以明文写在 HTML 里：var panLink = "..."。
// 「手机扫码转存」的二维码是用 qrcode.min.js 拿 panLink 现场生成的，不需要真的扫码。
//
// 注意：该站对普通 HTTP 客户端返回 403（TLS/指纹层面拦截），必须用真实浏览器（Playwright）。

const DEFAULT_MIRRORS = ["https://seedog.cc"];

export class SeedHub {
  /**
   * @param {object} opts
   * @param {import('playwright-core').Browser} opts.browser
   * @param {string} [opts.base]
   */
  constructor({ browser, base = DEFAULT_MIRRORS[0] }) {
    this.browser = browser;
    this.base = base.replace(/\/$/, "");
    this._ctx = null;
    this._page = null;
  }

  async _ensure() {
    if (!this._ctx) {
      this._ctx = await this.browser.newContext({
        locale: "zh-CN",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      });
      this._page = await this._ctx.newPage();
    }
    return this._page;
  }

  async _html(path) {
    const page = await this._ensure();
    const url = path.startsWith("http") ? path : this.base + path;
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = resp ? resp.status() : 0;
    const html = await page.content();
    return { status, html };
  }

  /** 列表页：/ 与 /?page=N */
  async listPage(n = 1) {
    const path = n <= 1 ? "/" : `/?page=${n}`;
    const { status, html } = await this._html(path);
    if (status !== 200) return { status, items: [] };
    return { status, items: parseList(html) };
  }

  /** 搜索：站点自身搜索接口被 nginx 屏蔽（/search-index.json 403），改为抓列表页 + 本地索引 */
  async detail(movieId) {
    const { status, html } = await this._html(`/movies/${movieId}/`);
    if (status !== 200) return { status, quark: [] };
    return { status, quark: parseQuarkEntries(html) };
  }

  /** 把 /link_start/... 页面里的明文 panLink 解析出来 */
  async resolveQuark(href) {
    const { status, html } = await this._html(href);
    const m = html.match(/var\s+panLink\s*=\s*"([^"]+)"/);
    if (!m) return { status, url: null, pwd: null };
    const raw = m[1];
    const url = raw.split("?")[0];
    const pwd = (raw.match(/[?&]pwd=([^&]+)/) || [])[1] || null;
    return { status, url, pwd, raw };
  }

  async close() {
    await this._ctx?.close();
  }
}

export function parseList(html) {
  const items = [];
  const blocks = html.split('<div class="cover">').slice(1);
  for (const b of blocks) {
    const id = (b.match(/href="\/movies\/(\d+)\//) || [])[1];
    if (!id) continue;
    const aTag = (b.match(/<a\b[^>]*class="image"[^>]*>/) || [])[0] || "";
    const title = (aTag.match(/title="([^"]*)"/) || [])[1] || "";
    const poster = (b.match(/<img src="([^"]+)"/) || [])[1] || "";
    const meta = (b.match(/<li>([^<]*\/[^<]*)<\/li>/) || [])[1] || "";
    const types = [...b.matchAll(/<a[^>]*title="([^"]+)"[^>]*href="\/categories\/\d+\/types\/\d+\/movies\/"/g)].map((m) => m[1]);
    const douban = (b.match(/douban\.com\/subject\/(\d+)\/">([\d.]+)</) || [])[2] || null;
    items.push({ id, title: decodeEntities(title), poster, meta: meta.trim(), types, douban });
  }
  return items;
}

export function parseQuarkEntries(html) {
  const out = [];
  for (const m of html.matchAll(/<a[^>]*data-link="pan\.quark\.cn"[^>]*>/g)) {
    const tag = m[0];
    const href = (tag.match(/href="([^"]+)"/) || [])[1];
    const title = (tag.match(/title="([^"]*)"/) || [])[1] || "";
    if (href) out.push({ href: decodeEntities(href), title: decodeEntities(title) });
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
