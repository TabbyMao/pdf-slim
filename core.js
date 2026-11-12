/* PDF Slim — core logic. Runs fully in the browser (also in Node for tests).
 * Needs globals: PDFLib (pdf-lib 1.17), pako.
 * Never rasterizes pages: text stays selectable, annotations/links/outlines kept.
 */
(function (root) {
  'use strict';
  const L = root.PDFLib;
  const { PDFName, PDFRef, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFStream } = L;
  const N = (s) => PDFName.of(s);

  // ---------- helpers ----------
  const WS = new Uint8Array(256);
  [0, 9, 10, 12, 13, 32].forEach((c) => (WS[c] = 1));
  const DELIM = new Uint8Array(256);
  '()<>[]{}/%'.split('').forEach((c) => (DELIM[c.charCodeAt(0)] = 1));

  function filtersOf(ctx, dict) {
    const f = ctx.lookup(dict.get(N('Filter')));
    if (!f) return [];
    if (f instanceof PDFName) return [f.asString()];
    if (f instanceof PDFArray) return f.asArray().map((x) => ctx.lookup(x).asString());
    return ['?'];
  }
  function num(ctx, v, d) {
    const x = ctx.lookup(v);
    return x instanceof PDFNumber ? x.asNumber() : d;
  }
  function nameOf(ctx, v) {
    const x = ctx.lookup(v);
    return x instanceof PDFName ? x.asString() : null;
  }
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  const TEXTUAL = new Set(['/ASCII85Decode', '/ASCIIHexDecode', '/A85', '/AHx']);
  const LOSSLESS = new Set(['/ASCII85Decode', '/ASCIIHexDecode', '/A85', '/AHx', '/FlateDecode', '/Fl', '/LZWDecode', '/LZW', '/RunLengthDecode', '/RL']);
  function decodeWith(ctx, bytes, filters) {
    const d = ctx.obj({});
    d.set(N('Filter'), filters.length === 1 ? N(filters[0].slice(1)) : ctx.obj(filters.map((f) => N(f.slice(1)))));
    return L.decodePDFRawStream(PDFRawStream.of(d, bytes)).decode();
  }
  function hasPredictor(ctx, dict) {
    let dp = ctx.lookup(dict.get(N('DecodeParms')));
    if (dp instanceof PDFArray) return dp.asArray().some((x) => { x = ctx.lookup(x); return x instanceof PDFDict && num(ctx, x.get(N('Predictor')), 1) > 1; });
    return dp instanceof PDFDict && num(ctx, dp.get(N('Predictor')), 1) > 1;
  }
  // Decode a stream's bytes if all its filters are ones we can undo losslessly.
  function decodeStream(ctx, s) {
    const fl = filtersOf(ctx, s.dict);
    if (fl.length === 0) return s.contents;
    if (!fl.every((f) => LOSSLESS.has(f)) || hasPredictor(ctx, s.dict)) return null;
    if (fl.length === 1 && (fl[0] === '/FlateDecode' || fl[0] === '/Fl')) {
      try { return pako.inflate(s.contents); } catch (e) { /* fall through */ }
    }
    try { return decodeWith(ctx, s.contents, fl); } catch (e) { return null; }
  }
  // Peel off leading ASCII85/Hex wrappers (pure overhead). Returns {bytes, filters} or null.
  function unwrapText(ctx, s) {
    const fl = filtersOf(ctx, s.dict);
    let k = 0;
    while (k < fl.length && TEXTUAL.has(fl[k])) k++;
    if (k === 0) return { bytes: s.contents, filters: fl };
    try { return { bytes: decodeWith(ctx, s.contents, fl.slice(0, k)), filters: fl.slice(k) }; } catch (e) { return null; }
  }
  function setFilters(ctx, dict, filters) {
    if (!filters.length) { dict.delete(N('Filter')); dict.delete(N('DecodeParms')); return; }
    const dp = ctx.lookup(dict.get(N('DecodeParms')));
    dict.set(N('Filter'), filters.length === 1 ? N(filters[0].slice(1)) : ctx.obj(filters.map((f) => N(f.slice(1)))));
    if (dp instanceof PDFArray) {
      const a = dp.asArray(), keep = a.slice(a.length - filters.length);
      if (keep.every((x) => !(ctx.lookup(x) instanceof PDFDict))) dict.delete(N('DecodeParms'));
      else dict.set(N('DecodeParms'), filters.length === 1 ? keep[0] : ctx.obj(keep));
    }
  }

  // ---------- content-stream rewriting ----------
  const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 're']);
  function fmt(x, d) {
    let s = x.toFixed(d);
    if (d > 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
    if (s.startsWith('0.')) s = s.slice(1);
    else if (s.startsWith('-0.')) s = '-' + s.slice(2);
    return s;
  }
  // mode: null = lossless tidy only; number = base decimals for path coords
  function rewriteContent(bytes, mode) {
    const n = bytes.length;
    const toks = []; // [start,end,type,wsBefore] type: 0 other,1 num,2 op
    let i = 0, ws = 0;
    while (i < n) {
      const c = bytes[i];
      if (WS[c]) { ws = c === 10 || c === 13 ? 2 : Math.max(ws, 1); i++; continue; }
      if (c === 37) { while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++; ws = 2; continue; } // comment
      const st = i;
      let type = 0;
      if (c === 40) { // ( string )
        let depth = 0;
        for (; i < n; i++) {
          const b = bytes[i];
          if (b === 92) { i++; continue; }
          if (b === 40) depth++;
          else if (b === 41) { depth--; if (depth === 0) { i++; break; } }
        }
      } else if (c === 60) { // < or <<
        if (bytes[i + 1] === 60) i += 2;
        else { while (i < n && bytes[i] !== 62) i++; i++; }
      } else if (c === 62) { i += bytes[i + 1] === 62 ? 2 : 1; }
      else if (c === 91 || c === 93 || c === 123 || c === 125) i++;
      else if (c === 47) { i++; while (i < n && !WS[bytes[i]] && !DELIM[bytes[i]]) i++; }
      else {
        while (i < n && !WS[bytes[i]] && !DELIM[bytes[i]]) i++;
        const isNum = (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46;
        type = isNum ? 1 : 2;
        if (type === 2 && i - st === 2 && c === 66 && bytes[st + 1] === 73) { // BI ... ID data EI
          let j = i;
          while (j < n - 1 && !(bytes[j] === 73 && bytes[j + 1] === 68 && WS[bytes[j - 1]] && (j + 2 >= n || WS[bytes[j + 2]]))) j++;
          j += 3;
          while (j < n - 1 && !(WS[bytes[j - 1]] && bytes[j] === 69 && bytes[j + 1] === 73 && (j + 2 >= n || WS[bytes[j + 2]] || DELIM[bytes[j + 2]]))) j++;
          i = Math.min(n, j + 2);
          type = 3; // raw inline image
        }
      }
      if (i === st) i++; // safety
      toks.push([st, i, type, ws]);
      ws = 0;
    }
    // mark path operands
    let roundIdx = null, dec = 0;
    if (mode !== null && mode !== undefined) {
      roundIdx = new Uint8Array(toks.length);
      let pending = [];
      let maxAbs = 0;
      for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        if (t[2] === 1) { pending.push(k); continue; }
        if (t[2] === 2) {
          const op = String.fromCharCode.apply(null, bytes.subarray(t[0], t[1]));
          if (PATH_OPS.has(op)) {
            for (const p of pending) {
              roundIdx[p] = 1;
              const v = Math.abs(parseFloat(String.fromCharCode.apply(null, bytes.subarray(toks[p][0], toks[p][1]))));
              if (v > maxAbs && isFinite(v)) maxAbs = v;
            }
          }
        }
        pending = [];
      }
      // adaptive precision: rounding step must stay tiny relative to the drawing's coordinate range
      dec = mode;
      while (dec < 4 && Math.pow(10, -dec) > Math.max(maxAbs, 1e-9) / 250) dec++;
    }
    // emit, collapsing whitespace to the minimum the syntax needs
    const out = [];
    let len = 0;
    const enc = (s) => { const a = new Uint8Array(s.length); for (let q = 0; q < s.length; q++) a[q] = s.charCodeAt(q); return a; };
    const isD = (b) => b === 40 || b === 41 || b === 60 || b === 62 || b === 91 || b === 93 || b === 123 || b === 125;
    let prevLast = 32, prevType = -1;
    for (let k = 0; k < toks.length; k++) {
      const [st, en, type, wsb] = toks[k];
      let piece;
      if (roundIdx && roundIdx[k]) {
        const v = parseFloat(String.fromCharCode.apply(null, bytes.subarray(st, en)));
        piece = isFinite(v) ? enc(fmt(v, dec)) : bytes.subarray(st, en);
      } else piece = bytes.subarray(st, en);
      if (k > 0) {
        if (type === 3 || prevType === 3) { out.push(NL); len++; }
        else if (wsb && !(isD(prevLast) || isD(bytes[st]) || bytes[st] === 47)) { out.push(wsb === 2 ? NL : SP); len++; }
      }
      out.push(piece); len += piece.length;
      prevLast = bytes[en - 1]; prevType = type;
    }
    const res = new Uint8Array(len);
    let o = 0;
    for (const p of out) { res.set(p, o); o += p.length; }
    return res;
  }
  const SP = new Uint8Array([32]), NL = new Uint8Array([10]);

  // ---------- images ----------
  function unpredictPNG(data, colors, bpc, columns) {
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowLen = Math.ceil((colors * bpc * columns) / 8);
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);
    for (let r = 0; r < rows; r++) {
      const ft = data[r * (rowLen + 1)];
      const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
      const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
      for (let x = 0; x < rowLen; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        let v = src[x];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        cur[x] = v & 255;
      }
      prev = cur;
    }
    return out;
  }

  function colorComps(ctx, csv) {
    const cs = ctx.lookup(csv);
    if (cs instanceof PDFName) {
      const s = cs.asString();
      return s === '/DeviceRGB' || s === '/CalRGB' ? 3 : s === '/DeviceGray' || s === '/CalGray' ? 1 : 0;
    }
    if (cs instanceof PDFArray) {
      const kind = nameOf(ctx, cs.get(0));
      if (kind === '/ICCBased') {
        const icc = ctx.lookup(cs.get(1));
        const nn = icc && icc.dict ? num(ctx, icc.dict.get(N('N')), 0) : 0;
        return nn === 1 || nn === 3 ? nn : 0;
      }
      if (kind === '/CalRGB') return 3;
      if (kind === '/CalGray') return 1;
    }
    return 0;
  }

  async function recompressImage(ctx, s, maxW, maxH, quality, env) {
    const d = s.dict;
    if (d.get(N('ImageMask')) || d.get(N('Decode'))) return null;
    const w = num(ctx, d.get(N('Width')), 0), h = num(ctx, d.get(N('Height')), 0);
    if (!w || !h) return null;
    const comps = colorComps(ctx, d.get(N('ColorSpace')));
    if (!comps) return null;
    const uw = unwrapText(ctx, s);
    if (!uw) return null;
    const fl = uw.filters, body = uw.bytes;
    const oldSize = body.length;
    if (oldSize < 30000) return null;
    const scale = Math.min(1, Math.max(maxW, maxH) / Math.max(w, h));
    let source; // ImageBitmap or ImageData
    if (fl.length === 1 && fl[0] === '/DCTDecode') {
      if (scale > 0.95 && quality >= 0.85) return null; // re-encoding an already-JPEG at same size rarely helps
      source = await env.decodeJpeg(body);
    } else if (fl.length === 1 && fl[0] === '/FlateDecode') {
      if (num(ctx, d.get(N('BitsPerComponent')), 8) !== 8) return null;
      let raw;
      try { raw = pako.inflate(body); } catch (e) { return null; }
      let dp = ctx.lookup(d.get(N('DecodeParms')));
      if (dp instanceof PDFArray) dp = ctx.lookup(dp.get(dp.size() - 1));
      const pred = dp ? num(ctx, dp.get(N('Predictor')), 1) : 1;
      if (pred >= 10) raw = unpredictPNG(raw, num(ctx, dp.get(N('Colors')), comps), 8, num(ctx, dp.get(N('Columns')), w));
      else if (pred !== 1) return null;
      if (raw.length < w * h * comps) return null;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let p = 0, q = 0; p < w * h; p++, q += comps) {
        if (comps === 3) { rgba[p * 4] = raw[q]; rgba[p * 4 + 1] = raw[q + 1]; rgba[p * 4 + 2] = raw[q + 2]; }
        else { rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = raw[q]; }
        rgba[p * 4 + 3] = 255;
      }
      source = { data: rgba, width: w, height: h };
    } else return null;
    if (!source) return null;
    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    const jpg = await env.encodeJpeg(source, nw, nh, quality, comps === 1);
    const jb = jpg && (jpg.bytes || jpg);
    if (!jb || jb.length > oldSize * 0.9) return null;
    d.set(N('Filter'), N('DCTDecode'));
    d.delete(N('DecodeParms'));
    d.set(N('Width'), PDFNumber.of(nw));
    d.set(N('Height'), PDFNumber.of(nh));
    d.set(N('BitsPerComponent'), PDFNumber.of(8));
    d.set(N('ColorSpace'), N(comps === 1 && jpg.gray ? 'DeviceGray' : 'DeviceRGB'));
    return jb;
  }

  // ---------- graph walking ----------
  function walk(ctx, obj, fn) {
    if (obj instanceof PDFDict) { for (const [k, v] of obj.entries()) fn(v, (nv) => obj.set(k, nv)); }
    else if (obj instanceof PDFArray) { const a = obj.asArray(); for (let i = 0; i < a.length; i++) fn(a[i], (nv) => obj.set(i, nv)); }
    else if (obj instanceof PDFStream) walk(ctx, obj.dict, fn);
  }
  function reachable(ctx) {
    const seen = new Set();
    const stack = [];
    const t = ctx.trailerInfo;
    [t.Root, t.Info, t.Encrypt].forEach((r) => r && stack.push(r));
    const visit = (o) => {
      if (o instanceof PDFRef) { if (!seen.has(o)) { seen.add(o); stack.push(o); } }
      else if (o instanceof PDFDict || o instanceof PDFArray || o instanceof PDFStream) walk(ctx, o, (v) => visit(v));
    };
    stack.forEach((r) => seen.add(r));
    while (stack.length) {
      const r = stack.pop();
      const o = ctx.lookup(r);
      if (o) walk(ctx, o, (v) => visit(v));
    }
    return seen;
  }
  function fnv(bytes) {
    let h = 0x811c9dc5;
    const step = bytes.length > 200000 ? 7 : 1;
    for (let i = 0; i < bytes.length; i += step) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + bytes.length;
  }
  function sameBytes(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  function dedupe(ctx) {
    let total = 0;
    for (let pass = 0; pass < 6; pass++) {
      const groups = new Map();
      const map = new Map();
      for (const [ref, o] of ctx.enumerateIndirectObjects()) {
        if (!(o instanceof PDFRawStream)) continue;
        const ds = o.dict.toString().replace(/\/Length\s+(\d+\s+\d+\s+R|\d+)/, '');
        const key = fnv(o.contents) + '|' + ds;
        const g = groups.get(key);
        if (!g) { groups.set(key, [[ref, o]]); continue; }
        const hit = g.find(([, oo]) => sameBytes(oo.contents, o.contents));
        if (hit) map.set(ref, hit[0]); else g.push([ref, o]);
      }
      if (!map.size) break;
      total += map.size;
      const fix = (v, set) => { if (v instanceof PDFRef && map.has(v)) set(map.get(v)); };
      for (const [, o] of ctx.enumerateIndirectObjects()) walk(ctx, o, fix);
      for (const r of map.keys()) ctx.delete(r);
    }
    return total;
  }

  // Which page size does each image appear on (for target resolution)?
  function imagePageBoxes(doc) {
    const ctx = doc.context;
    const box = new Map();
    let maxPage = [612, 792];
    const visitRes = (res, pw, ph, depth, seenForms) => {
      res = ctx.lookup(res);
      if (!(res instanceof PDFDict) || depth > 8) return;
      const xo = ctx.lookup(res.get(N('XObject')));
      if (!(xo instanceof PDFDict)) return;
      for (const [, v] of xo.entries()) {
        if (!(v instanceof PDFRef)) continue;
        const s = ctx.lookup(v);
        if (!(s instanceof PDFStream)) continue;
        const st = nameOf(ctx, s.dict.get(N('Subtype')));
        if (st === '/Image') {
          const b = box.get(v) || [0, 0];
          box.set(v, [Math.max(b[0], pw), Math.max(b[1], ph)]);
        } else if (st === '/Form' && !seenForms.has(v)) {
          seenForms.add(v);
          visitRes(s.dict.get(N('Resources')), pw, ph, depth + 1, seenForms);
        }
      }
    };
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      if (width * height > maxPage[0] * maxPage[1]) maxPage = [width, height];
      visitRes(page.node.Resources(), width, height, 0, new Set());
    }
    return { box, maxPage };
  }

  // ---------- main ----------
  /**
   * opts: { vector: null|1|0, imageDpi: 0|dpi, imageQuality: 0..1 }
   * env:  { decodeJpeg(bytes)->source, encodeJpeg(source,w,h,q,gray)->{bytes,gray}|Uint8Array, progress(msg,frac) }
   */
  async function slim(input, opts, env) {
    const progress = env.progress || (() => {});
    progress('Parsing PDF…', 0.02);
    const doc = await L.PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
    if (doc.isEncrypted) { const e = new Error('This PDF is encrypted (password or permission restrictions), so it can\'t be processed.'); e.code = 'encrypted'; throw e; }
    const ctx = doc.context;
    const stats = { vector: 0, images: 0, imagesDone: 0, deduped: 0, recompressed: 0, removed: 0 };

    // strip junk
    const cat = doc.catalog;
    cat.delete(N('PieceInfo'));
    for (const p of doc.getPages()) { p.node.delete(N('Thumb')); p.node.delete(N('PieceInfo')); }

    // drop unreachable first so we don't waste time on them
    let keep = reachable(ctx);
    for (const [r] of ctx.enumerateIndirectObjects()) if (!keep.has(r)) { ctx.delete(r); stats.removed++; }

    // classify streams
    const contentRefs = new Set();
    for (const p of doc.getPages()) {
      const c = p.node.get(N('Contents'));
      if (c instanceof PDFRef) {
        const o = ctx.lookup(c);
        if (o instanceof PDFArray) o.asArray().forEach((x) => x instanceof PDFRef && contentRefs.add(x));
        else contentRefs.add(c);
      } else if (c instanceof PDFArray) c.asArray().forEach((x) => x instanceof PDFRef && contentRefs.add(x));
    }
    const smaskRefs = new Set();
    const all = ctx.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream);
    for (const [, o] of all) {
      for (const k of ['SMask', 'Mask']) { const v = o.dict.get(N(k)); if (v instanceof PDFRef) smaskRefs.add(v); }
    }
    const { box, maxPage } = opts.imageDpi ? imagePageBoxes(doc) : { box: new Map(), maxPage: [612, 792] };

    let idx = 0;
    for (const [ref, s] of all) {
      idx++;
      if (idx % 25 === 0) { progress(`Optimizing objects ${idx}/${all.length}…`, 0.05 + 0.8 * idx / all.length); await yieldUI(); }
      const d = s.dict;
      const type = nameOf(ctx, d.get(N('Type')));
      if (type === '/XRef' || type === '/ObjStm') continue;
      const sub = nameOf(ctx, d.get(N('Subtype')));
      const before = s.contents.length;

      if (sub === '/Image') {
        stats.images++;
        if (opts.imageDpi && !smaskRefs.has(ref)) {
          const b = box.get(ref) || maxPage;
          try {
            const nb = await recompressImage(ctx, s, Math.ceil(b[0] / 72 * opts.imageDpi), Math.ceil(b[1] / 72 * opts.imageDpi), opts.imageQuality, env);
            if (nb) { ctx.assign(ref, PDFRawStream.of(d, nb)); stats.imagesDone++; continue; }
          } catch (e) { /* keep original */ }
        }
        // lossless: strip ASCII wrappers around JPEG / JPX / JBIG2 / CCITT data
        const fl0 = filtersOf(ctx, d);
        if (fl0.length > 1 && TEXTUAL.has(fl0[0]) && !fl0.slice(1).every((f) => LOSSLESS.has(f))) {
          const uw = unwrapText(ctx, s);
          if (uw && uw.bytes.length < before) { setFilters(ctx, d, uw.filters); ctx.assign(ref, PDFRawStream.of(d, uw.bytes)); stats.recompressed++; }
          continue;
        }
      }

      const isContent = contentRefs.has(ref) || sub === '/Form';
      const fl = filtersOf(ctx, d);
      if (!fl.every((f) => LOSSLESS.has(f)) || hasPredictor(ctx, d)) continue;
      if (!isContent && type === '/Metadata') continue;
      const raw = decodeStream(ctx, s);
      if (!raw) continue;
      let data = raw;
      if (isContent) {
        try { data = rewriteContent(raw, opts.vector); } catch (e) { data = raw; }
      }
      const z = pako.deflate(data, { level: 9 });
      if (z.length < before) {
        d.set(N('Filter'), N('FlateDecode'));
        d.delete(N('DecodeParms'));
        ctx.assign(ref, PDFRawStream.of(d, z));
        if (isContent) stats.vector++; else stats.recompressed++;
      }
    }

    progress('Merging duplicates…', 0.88);
    await yieldUI();
    stats.deduped = dedupe(ctx);
    keep = reachable(ctx);
    for (const [r] of ctx.enumerateIndirectObjects()) if (!keep.has(r)) { ctx.delete(r); stats.removed++; }

    progress('Writing file…', 0.93);
    await yieldUI();
    const out = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 200 });
    progress('Done', 1);
    return { bytes: out, stats, pages: doc.getPageCount() };
  }

  root.PDFSlim = { slim, rewriteContent };
})(typeof window !== 'undefined' ? window : globalThis);
