// 字幕解析/转换：纯函数，方便单测（scripts/test-subs-unit.mjs）
// 支持 SRT / WebVTT / ASS / SSA → WebVTT，含 GBK 等编码识别与时间轴平移。

export const SUBS_EXT = /\.(srt|ass|ssa|vtt|smi|sub)$/i;

// 中文字幕十有八九是 GBK/GB18030，Node 自带 TextDecoder 就能解，不用装库
export function decodeSubText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf.subarray(3));
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { try { return new TextDecoder("gb18030").decode(buf); } catch { return buf.toString("utf8"); } }
}

export function ts2sec(s) {
  const m = String(s).trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

// SRT 与 WebVTT 的时间轴语法一致（只差毫秒分隔符），共用一套解析
export function textCues(text) {
  const cues = [];
  for (const block of String(text).replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [aRaw, bRaw] = lines[ti].split("-->");
    const a = ts2sec(aRaw), b = ts2sec(String(bRaw).trim().split(/\s+/)[0]);
    if (a == null || b == null) continue;
    const txt = lines.slice(ti + 1).join("\n");
    if (!txt.trim()) continue;
    cues.push({ a, b, txt });
  }
  return cues;
}

// ASS/SSA：只取 [Events] 里的 Dialogue，样式标记一律剥掉（播放器按自己的样式渲染）
export function assCues(text) {
  const cues = [];
  let fmt = null, inEvents = false;
  for (const raw of String(text).replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "").split("\n")) {
    const line = raw.trim();
    if (/^\[[^\]]*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); fmt = null; continue; }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) { fmt = line.slice(line.indexOf(":") + 1).split(",").map((s) => s.trim().toLowerCase()); continue; }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const body = line.slice(line.indexOf(":") + 1);
    const cols = [];
    let cur = "";
    const keep = fmt ? Math.max(1, fmt.length - 1) : 9;
    for (const ch of body) { if (ch === "," && cols.length < keep) { cols.push(cur); cur = ""; } else cur += ch; }
    cols.push(cur);
    const at = (n) => { const i = fmt ? fmt.indexOf(n) : -1; return i >= 0 ? cols[i] : null; };
    const a = ts2sec(at("start") ?? (cols[fmt ? fmt.length - 1 : 1] || ""));
    const b = ts2sec(at("end") ?? (cols[fmt ? fmt.length - 1 : 2] || ""));
    let txt = at("text") ?? cols[cols.length - 1] ?? "";
    if (a == null || b == null || !txt.trim()) continue;
    txt = txt.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ").trim();
    if (!txt) continue;
    cues.push({ a, b, txt });
  }
  return cues;
}

export function cuesToVtt(cues, delay = 0) {
  const f = (s) => {
    const t = Math.max(0, s + delay);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + sec.toFixed(3).padStart(6, "0");
  };
  const out = ["WEBVTT", ""];
  let i = 0;
  for (const c of cues) { i++; out.push(String(i)); out.push(f(c.a) + " --> " + f(c.b)); out.push(c.txt.trim()); out.push(""); }
  return out.join("\n");
}

/** 已生成好的 WebVTT 再平移一次（用于内封字幕：磁盘缓存不带延迟，播放时才按需平移） */
export function shiftVtt(vtt, delay = 0) {
  return delay ? cuesToVtt(textCues(vtt), delay) : vtt;
}

export function toVtt(text, ext, delay = 0) {
  const e = String(ext || "").toLowerCase();
  const cues = e === "ass" || e === "ssa" ? assCues(text) : textCues(text);
  return cuesToVtt(cues, delay);
}

/* 字幕与视频的配对：先归一化去掉语言/后缀标记，再按「同名 → 同前缀 → 同集号」打分 */
const SUB_LANG = { chs: "简中", sc: "简中", zh: "中文", chi: "中文", cht: "繁中", tc: "繁中", eng: "英文", en: "英文", jpn: "日文", jp: "日文", kor: "韩文", ko: "韩文" };
export function subLang(name) {
  const s = String(name).toLowerCase();
  if (/简体|简中|中字/.test(s)) return "简中";
  if (/繁体|繁中/.test(s)) return "繁中";
  if (/双语/.test(s)) return "双语";
  const m = s.match(/[.\[(_ —-]((?:chs|cht|chi|zh|sc|tc|eng|en|jpn|jp|kor|ko))[.\])_ —-]/);
  return m ? (SUB_LANG[m[1]] || "") : "";
}
export function subBase(s) {
  return String(s)
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[.\[(_ —-](chs|cht|chi|zh|sc|tc|eng|en|jpn|jp|kor|ko|简体|繁体|简中|繁中|中字|双语)[.\])_ —-]?/gi, "")
    .replace(/[\s._\-\[\]()（）【】·]/g, "").toLowerCase();
}
export function epNo(name) {
  const s = String(name); let m;
  if ((m = s.match(/第\s*(\d+)\s*[集话期回]/))) return Number(m[1]);
  if ((m = s.match(/[Ss](\d{1,2})[Ee](\d{1,3})/))) return Number(m[2]);
  if ((m = s.match(/[Ee][Pp]?\s*(\d{1,4})(?!\d)/))) return Number(m[1]);
  if ((m = s.match(/(\d{1,4})\s*[.\-_ ]?(?:mkv|mp4|ts|avi|mov|webm|srt|ass|vtt|ssa)$/i))) return Number(m[1]);
  return null;
}
export function subScore(videoName, subName) {
  const v = subBase(videoName), s = subBase(subName);
  if (!s) return 1;
  if (v === s) return 100;
  if (s.startsWith(v) || v.startsWith(s)) return 85;
  const ev = epNo(videoName), es = epNo(subName);
  if (ev != null && es != null && ev === es) return 70;
  let n = 0; while (n < v.length && n < s.length && v[n] === s[n]) n++;
  if (n >= 4) return 45;
  return 10;
}
