// MP4/MOV 内封字幕（tx3g / mov_text）抽取：纯解析逻辑，网络 I/O 在 server.mjs。
//
// 背景：用户的 MKV 大多带内封字幕，但夸克播放接口只把字幕轨列成 {index, lang}（没有字幕直链），
// 转码出来的 m3u8 里也没有 #EXT-X-MEDIA:TYPE=SUBTITLES。好在夸克转码的 MP4 把内封字幕做成了
// tx3g 轨，位置信息（moov_size / moov_behind）也一起给了 —— 于是可以只 Range 取 moov 和字幕样本，
// 自己解出文本，不用打包 ffmpeg。

export const SUB_HANDLERS = new Set(["sbtl", "text", "subp"]);
const LANG_OK = /^[a-z]{3}$/;

/** 顺序读 box 头；buffer 尾部允许被截断（只读到 box 头也能知道真实大小） */
export function readBoxes(buf, start, end) {
  const list = [];
  const limit = end == null ? buf.length : end;
  let off = start;
  while (off + 8 <= limit) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let body = off + 8;
    if (size === 1) { if (off + 16 > limit) break; size = Number(buf.readBigUInt64BE(off + 8)); body = off + 16; }
    else if (size === 0) size = limit - off;
    if (size < 8) break;
    list.push({ type, start: off, size, body });
    if (off + size > limit) break;
    off += size;
  }
  return list;
}
export function findBox(list, type, nth = 0) {
  let n = 0;
  for (const b of list) if (b.type === type) { if (n === nth) return b; n++; }
  return null;
}
export function childBoxes(buf, box) { return readBoxes(buf, box.body, box.start + box.size); }

/** 在 buffer 里找 moov（正向：moov 在文件开头时用） */
export function locateMoovForward(buf, from = 0) {
  for (let i = Math.max(0, from); i + 8 <= buf.length; i++) {
    if (buf[i] !== 0x6d || buf[i + 1] !== 0x6f || buf[i + 2] !== 0x6f || buf[i + 3] !== 0x76) continue;
    const start = i - 4;
    if (start < 0) continue;
    let size = buf.readUInt32BE(start), body = start + 8;
    if (size === 1) { if (start + 16 > buf.length) continue; size = Number(buf.readBigUInt64BE(start + 8)); body = start + 16; }
    if (size < 8 || size > 512 * 1048576) continue;   // 上限防误命中
    return { start, size, body };
  }
  return null;
}
/** 反向：moov 在文件尾部时用（moov 通常是最后一个 box） */
export function locateMoovBackward(buf) {
  for (let i = buf.length - 8; i >= 4; i--) {
    if (buf[i] !== 0x6d || buf[i + 1] !== 0x6f || buf[i + 2] !== 0x6f || buf[i + 3] !== 0x76) continue;
    const start = i - 4;
    let size = buf.readUInt32BE(start), body = start + 8;
    if (size === 1) { if (start + 16 > buf.length) continue; size = Number(buf.readBigUInt64BE(start + 8)); body = start + 16; }
    if (size < 8 || size > 512 * 1048576) continue;
    if (start + size > buf.length) continue;   // 尾块里必须完整包含
    return { start, size, body };
  }
  return null;
}

/** 解析 moov 里的所有 trak（含字幕轨的采样表） */
export function parseTracks(buf, moov) {
  const tracks = [];
  for (const trak of childBoxes(buf, moov).filter((b) => b.type === "trak")) {
    const mdia = findBox(childBoxes(buf, trak), "mdia");
    if (!mdia) continue;
    const kids = childBoxes(buf, mdia);
    const hdlr = findBox(kids, "hdlr");
    const handler = hdlr ? buf.toString("latin1", hdlr.body + 8, hdlr.body + 12) : "";
    const mdhd = findBox(kids, "mdhd");
    let timescale = 0, language = "";
    if (mdhd) {
      const v = buf[mdhd.body];
      // v0: creation/modification 各 4 字节；v1: 各 8 字节。timescale 两种版本都是 uint32。
      const tsOff = mdhd.body + (v === 1 ? 20 : 12);
      const langOff = mdhd.body + (v === 1 ? 32 : 20);
      if (tsOff + 4 <= buf.length) timescale = buf.readUInt32BE(tsOff);
      if (langOff + 2 <= buf.length) {
        const p = buf.readUInt16BE(langOff);
        const s = String.fromCharCode(((p >> 10) & 31) + 0x60, ((p >> 5) & 31) + 0x60, (p & 31) + 0x60);
        language = LANG_OK.test(s) ? s : "";
      }
    }
    const t = { handler, timescale, language, format: "", sampleCount: 0, sizes: null, chunks: null, stsc: null, stts: null };
    const minf = findBox(kids, "minf");
    const stbl = minf ? findBox(childBoxes(buf, minf), "stbl") : null;
    if (stbl) {
      const sks = childBoxes(buf, stbl);
      const stsd = findBox(sks, "stsd");
      if (stsd) t.format = buf.toString("latin1", stsd.body + 12, stsd.body + 16);
      const stsz = findBox(sks, "stsz");
      if (stsz) {
        const uniform = buf.readUInt32BE(stsz.body + 4);
        t.sampleCount = buf.readUInt32BE(stsz.body + 8);
        if (uniform) { t.sizes = uniform; t.sampleCount = Math.floor((stsz.size - 12) / 4); }
        else { t.sizes = []; for (let i = 0; i < t.sampleCount; i++) t.sizes.push(buf.readUInt32BE(stsz.body + 12 + i * 4)); }
      }
      const stsc = findBox(sks, "stsc");
      if (stsc) {
        const n = buf.readUInt32BE(stsc.body + 4);
        t.stsc = [];
        for (let i = 0; i < n; i++) t.stsc.push({ first: buf.readUInt32BE(stsc.body + 8 + i * 12), per: buf.readUInt32BE(stsc.body + 12 + i * 12) });
      }
      const stco = findBox(sks, "stco"), co64 = findBox(sks, "co64");
      if (stco) { const n = buf.readUInt32BE(stco.body + 4); t.chunks = []; for (let i = 0; i < n; i++) t.chunks.push(buf.readUInt32BE(stco.body + 8 + i * 4)); }
      else if (co64) { const n = buf.readUInt32BE(co64.body + 4); t.chunks = []; for (let i = 0; i < n; i++) t.chunks.push(Number(buf.readBigUInt64BE(co64.body + 8 + i * 8))); }
      const stts = findBox(sks, "stts");
      if (stts) {
        const n = buf.readUInt32BE(stts.body + 4);
        t.stts = [];
        for (let i = 0; i < n; i++) t.stts.push({ count: buf.readUInt32BE(stts.body + 8 + i * 8), delta: buf.readUInt32BE(stts.body + 12 + i * 8) });
      }
    }
    tracks.push(t);
  }
  return tracks;
}

/** 由 stsc/stco/stsz 推出每个样本在文件里的偏移（字节） */
export function sampleOffsets(track) {
  const out = [];
  if (!track.chunks || !track.stsc || !track.sizes) return out;
  const sizeAt = (i) => (typeof track.sizes === "number" ? track.sizes : track.sizes[i] || 0);
  let idx = 0;
  for (let ci = 0; ci < track.chunks.length && idx < track.sampleCount; ci++) {
    const oneBased = ci + 1;
    let per = 1;
    for (let k = 0; k < track.stsc.length; k++) if (track.stsc[k].first <= oneBased) per = track.stsc[k].per;
    let off = track.chunks[ci];
    for (let k = 0; k < per && idx < track.sampleCount; k++) {
      const size = sizeAt(idx);
      out.push({ offset: off, size });
      off += size;
      idx++;
    }
  }
  return out;
}

/** 时间轴：stts 展开成每个样本的起点/时长（秒） */
export function sampleTimes(track) {
  const out = [];
  const ts = track.timescale || 1000;
  let t = 0;
  for (const { count, delta } of track.stts || []) {
    const dur = delta / ts;
    for (let i = 0; i < count; i++) { out.push({ start: t, dur }); t += dur; }
  }
  return out;
}

/** tx3g 样本 → 文本（前 2 字节是文本长度；UTF-8 或带 BOM 的 UTF-16，后面可能跟样式 box） */
export function decodeTx3g(buf) {
  if (!buf || buf.length < 2) return "";
  const len = buf.readUInt16BE(0);
  const end = Math.min(buf.length, 2 + len);
  const body = buf.subarray(2, end);
  let text;
  // 3GPP 定时文本：UTF-8，或带 BOM 的 UTF-16（BOM 本身算在长度里，解之前要跳过）
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) text = new TextDecoder("utf-16le").decode(body.subarray(2));
  else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) text = new TextDecoder("utf-16be").decode(body.subarray(2));
  else text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  return text.replace(/\u0000+$/, "").replace(/\r\n?/g, "\n").trim();
}

/** 把零散的样本区间合并成少量 Range 请求（字幕样本通常连续，合并后一般只剩个位数请求） */
export function mergeRanges(samples, maxGap = 262144) {
  const sorted = samples.slice().sort((a, b) => a.offset - b.offset);
  const ranges = [];
  for (const s of sorted) {
    if (!s.size) continue;
    const last = ranges[ranges.length - 1];
    const end = s.offset + s.size - 1;
    if (last && s.offset - last.end <= maxGap) last.end = Math.max(last.end, end);
    else ranges.push({ start: s.offset, end });
  }
  return ranges;
}

/** 用「已按区间取回的字节」拼出一个样本 */
export function sliceSample(fetchMap, sample) {
  for (const r of fetchMap) {
    if (sample.offset >= r.start && sample.offset + sample.size - 1 <= r.end) {
      const rel = sample.offset - r.start;
      return r.buf.subarray(rel, rel + sample.size);
    }
  }
  return null;
}
