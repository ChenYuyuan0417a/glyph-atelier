/* ===================================================================
 *  font-engine.js — 纯浏览器端的字体解析 / 字形编辑 / 字体重建引擎
 *  支持读取：TTF、OTF(CFF)、TTC(字体集合)
 *  支持写出：TrueType(glyf) 单字体，可选 TTC 包装
 *  不依赖任何第三方库，可离线运行
 * =================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------
   *  基础工具
   * --------------------------------------------------------------- */
  function readTag(dv, off) {
    return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  }
  function tagBytes(tag) {
    const a = new Uint8Array(4);
    for (let i = 0; i < 4; i++) a[i] = tag.charCodeAt(i) & 0xff;
    return a;
  }
  function checksum(bytes, start, end) {
    start = start || 0;
    end = end === undefined ? bytes.length : end;
    let sum = 0, i = start;
    for (; i + 3 < end; i += 4) {
      sum = (sum + ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3])) >>> 0;
    }
    if (i < end) {
      let v = 0;
      for (let k = 0; k < 4; k++) {
        v = (v << 8) | (i + k < end ? bytes[i + k] : 0);
      }
      sum = (sum + (v >>> 0)) >>> 0;
    }
    return sum >>> 0;
  }

  /** 可变长字节写入器 */
  class Buf {
    constructor(cap) {
      this.a = new Uint8Array(cap || 256);
      this.n = 0;
    }
    _grow(k) {
      if (this.n + k <= this.a.length) return;
      let cap = this.a.length;
      while (cap < this.n + k) cap *= 2;
      const b = new Uint8Array(cap);
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
    u8(v) { this._grow(1); this.a[this.n++] = v & 0xff; return this; }
    i8(v) { this._grow(1); this.a[this.n++] = v & 0xff; return this; }
    u16(v) { this._grow(2); this.a[this.n++] = (v >>> 8) & 0xff; this.a[this.n++] = v & 0xff; return this; }
    i16(v) { this._grow(2); const s = v < 0 ? v + 0x10000 : v; this.a[this.n++] = (s >>> 8) & 0xff; this.a[this.n++] = s & 0xff; return this; }
    u32(v) {
      this._grow(4);
      this.a[this.n++] = (v >>> 24) & 0xff; this.a[this.n++] = (v >>> 16) & 0xff;
      this.a[this.n++] = (v >>> 8) & 0xff; this.a[this.n++] = v & 0xff;
      return this;
    }
    bytes(arr) {
      this._grow(arr.length);
      this.a.set(arr, this.n);
      this.n += arr.length;
      return this;
    }
    get length() { return this.n; }
    out() { return this.a.subarray(0, this.n); }
  }

  function pad4(buf) {
    while (buf.length % 4) buf.u8(0);
  }

  /* ---------------------------------------------------------------
   *  CFF (Type2 charstring) 解析 —— 用于读取 OTF 轮廓
   * --------------------------------------------------------------- */
  function parseIndex(dv, off) {
    const count = dv.getUint16(off);
    if (count === 0) return { count: 0, offSize: 0, offsets: [off + 2], dataStart: off + 2, end: off + 2 };
    const offSize = dv.getUint8(off + 2);
    const start = off + 3;
    const offsets = new Array(count + 1);
    for (let i = 0; i <= count; i++) {
      let v = 0;
      for (let k = 0; k < offSize; k++) v = (v * 256) + dv.getUint8(start + i * offSize + k);
      offsets[i] = v;
    }
    const dataStart = start + (count + 1) * offSize - 1;
    return { count, offSize, offsets, dataStart, end: dataStart + offsets[count] };
  }

  function dictParse(data, dv, base) {
    const out = {};
    let i = 0;
    const stack = [];
    while (i < data.length) {
      const b = data[i];
      if (b <= 21) {
        let op = b, key;
        if (b === 12) { op = 1200 + data[i + 1]; i += 2; } else i++;
        switch (op) {
          case 1200: key = 'version'; break; case 1201: key = 'Notice'; break;
          case 1202: key = 'FullName'; break; case 1203: key = 'FamilyName'; break;
          case 1204: key = 'Weight'; break; case 1205: key = 'FontBBox'; break;
          case 1206: key = 'BlueValues'; break; case 1207: key = 'OtherBlues'; break;
          case 1208: key = 'FamilyBlues'; break; case 1209: key = 'FamilyOtherBlues'; break;
          case 12010: key = 'StdHW'; break; case 12011: key = 'StdVW'; break;
          case 12012: key = 'BlueScale'; break; case 12030: key = 'ROS'; break;
          case 12036: key = 'FDArray'; break; case 12037: key = 'FDSelect'; break;
          case 12038: key = 'FontName'; break;
          case 0: key = 'version'; break; case 1: key = 'Notice'; break;
          case 2: key = 'FullName'; break; case 3: key = 'FamilyName'; break;
          case 4: key = 'Weight'; break; case 5: key = 'FontBBox'; break;
          case 13: key = 'UniqueID'; break; case 14: key = 'XUID'; break;
          case 15: key = 'charset'; break; case 16: key = 'Encoding'; break;
          case 17: key = 'CharStrings'; break; case 18: key = 'Private'; break;
          case 19: key = 'Subrs'; break; case 20: key = 'defaultWidthX'; break;
          case 21: key = 'nominalWidthX'; break;
          case 6: key = 'BlueValues'; break;
          default: key = 'op' + op;
        }
        out[key] = stack.slice();
        stack.length = 0;
      } else if (b === 28) { stack.push(dv.getInt16(base + i + 1)); i += 3; }
      else if (b === 29) { stack.push(dv.getInt32(base + i + 1)); i += 5; }
      else if (b === 30) { // real number
        i++;
        let s = '';
        let done = false;
        while (i < data.length && !done) {
          const v = data[i++];
          for (let k = 0; k < 2; k++) {
            const nib = k === 0 ? (v >> 4) : (v & 15);
            if (nib === 0xf) { done = true; break; }
            if (nib <= 9) s += nib;
            else if (nib === 10) s += '.';
            else if (nib === 11) s += 'E';
            else if (nib === 12) s += 'E-';
            else if (nib === 14) s += '-';
            else s += '';
          }
        }
        stack.push(parseFloat(s) || 0);
      } else if (b >= 32 && b <= 246) { stack.push(b - 139); i++; }
      else if (b >= 247 && b <= 250) { stack.push((b - 247) * 256 + data[i + 1] + 108); i += 2; }
      else if (b >= 251 && b <= 254) { stack.push(-(b - 251) * 256 - data[i + 1] - 108); i += 2; }
      else i++;
    }
    return out;
  }

  function subrBias(n) { return n < 1240 ? 107 : n < 33900 ? 1131 : 32768; }

  class CFFFont {
    constructor(face) {
      this.face = face;
      const t = face.tables['CFF '];
      if (!t) throw new Error('缺少 CFF 表');
      this.start = t.offset;
      this.dv = face.dv;
      const dv = this.dv;
      const hdrSize = dv.getUint8(t.offset + 2);
      this.hdrSize = hdrSize;
      let p = t.offset + hdrSize;
      this.nameIndex = parseIndex(dv, p); p = this.nameIndex.end;
      this.topDictIndex = parseIndex(dv, p); p = this.topDictIndex.end;
      this.stringIndex = parseIndex(dv, p); p = this.stringIndex.end;
      this.globalSubrs = parseIndex(dv, p);
      this.topDict = this._dictAt(this.topDictIndex, 0);
      this.charStrings = parseIndex(dv, t.offset + this.topDict.CharStrings[0]);
      this.gsubrs = this._subrs(t.offset + this.globalSubrs.dataStart - 1 + 1, this.globalSubrs);
      // private dict
      this.defaultWidthX = 0;
      this.nominalWidthX = 0;
      this.subrs = [];
      this.isCID = !!this.topDict.ROS;
      this.fdSelect = null;
      this.fdPrivate = [];
      if (this.isCID) {
        this._parseCID();
      } else {
        this._parsePrivate(this.topDict.Private, t.offset);
      }
    }
    _dictAt(index, i) {
      const { offsets, dataStart } = index;
      const s = dataStart + offsets[i], e = dataStart + offsets[i + 1];
      const data = new Uint8Array(this.dv.buffer, this.dv.byteOffset + s, e - s);
      return dictParse(data, this.dv, s);
    }
    _subrs(base, index) {
      if (!index) return { arr: [], bias: 0 };
      const arr = [];
      for (let i = 0; i < index.count; i++) {
        const s = index.dataStart + index.offsets[i], e = index.dataStart + index.offsets[i + 1];
        arr.push(new Uint8Array(this.dv.buffer, this.dv.byteOffset + s, e - s));
      }
      return { arr, bias: subrBias(index.count) };
    }
    _parsePrivate(pv, base) {
      if (!pv) return;
      const size = pv[0], off = pv[1];
      const abs = base + off;
      const data = new Uint8Array(this.dv.buffer, this.dv.byteOffset + abs, size);
      const d = dictParse(data, this.dv, abs);
      this.defaultWidthX = d.defaultWidthX ? d.defaultWidthX[0] : 0;
      this.nominalWidthX = d.nominalWidthX ? d.nominalWidthX[0] : 0;
      if (d.Subrs) {
        const subOff = abs + d.Subrs[0];
        const idx = parseIndex(this.dv, subOff);
        this.subrs = this._subrs(subOff, idx);
      }
    }
    _parseCID() {
      const base = this.start;
      const fdArray = parseIndex(this.dv, base + this.topDict.FDArray[0]);
      for (let i = 0; i < fdArray.count; i++) {
        const d = this._dictAt(fdArray, i);
        const holder = { defaultWidthX: 0, nominalWidthX: 0, subrs: { arr: [], bias: 0 } };
        if (d.Private) {
          const size = d.Private[0], off = d.Private[1];
          const abs = base + off;
          const data = new Uint8Array(this.dv.buffer, this.dv.byteOffset + abs, size);
          const pd = dictParse(data, this.dv, abs);
          holder.defaultWidthX = pd.defaultWidthX ? pd.defaultWidthX[0] : 0;
          holder.nominalWidthX = pd.nominalWidthX ? pd.nominalWidthX[0] : 0;
          if (pd.Subrs) {
            const subOff = abs + pd.Subrs[0];
            holder.subrs = this._subrs(subOff, parseIndex(this.dv, subOff));
          }
        }
        this.fdPrivate.push(holder);
      }
      // FDSelect
      const fdSelOff = base + this.topDict.FDSelect[0];
      const fmt = this.dv.getUint8(fdSelOff);
      const n = this.charStrings.count;
      this.fdSelect = new Uint8Array(n);
      if (fmt === 0) {
        for (let i = 0; i < n; i++) this.fdSelect[i] = this.dv.getUint8(fdSelOff + 1 + i);
      } else if (fmt === 3) {
        const nRanges = this.dv.getUint16(fdSelOff + 1);
        for (let r = 0; r < nRanges; r++) {
          const first = this.dv.getUint16(fdSelOff + 3 + r * 3);
          const fd = this.dv.getUint8(fdSelOff + 5 + r * 3);
          const next = this.dv.getUint16(fdSelOff + 3 + (r + 1) * 3);
          for (let g = first; g < next && g < n; g++) this.fdSelect[g] = fd;
        }
      }
    }
    charString(gid) { return this.charStrings.dataStart + this.charStrings.offsets[gid]; }
    /** 解码为轮廓点（quadratic 近似） */
    getPath(gid) {
      const { arr, bias } = this.isCID ? this.fdPrivate[this.fdSelect[gid] || 0].subrs : this.subrs;
      const cs = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.charString(gid),
        this.charStrings.offsets[gid + 1] - this.charStrings.offsets[gid]);
      const widthBase = this.isCID ? this.fdPrivate[this.fdSelect[gid] || 0] : this;
      const paths = [];
      let cur = null;
      let x = 0, y = 0;
      let width = null;
      let nStems = 0;
      let haveWidth = false;
      const stack = [];
      let ip = 0, ipLimit = 0;
      let callDepth = 0;

      const moveTo = (nx, ny) => { x = nx; y = ny; cur = [{ x, y, on: true }]; paths.push(cur); };
      const lineTo = (nx, ny) => { x = nx; y = ny; if (!cur) { cur = [{ x, y, on: true }]; paths.push(cur); } else cur.push({ x, y, on: true }); };
      const curveTo = (c1x, c1y, c2x, c2y, ex, ey) => {
        if (!cur) { cur = [{ x, y, on: true }]; paths.push(cur); }
        cubicToQuads(x, y, c1x, c1y, c2x, c2y, ex, ey, cur);
        x = ex; y = ey;
      };

      function exec(prog, isSubr) {
        let i = 0;
        while (i < prog.length) {
          const b = prog[i];
          if (b >= 32 || b === 28) {
            // 数字
            if (b === 28) { stack.push(((prog[i + 1] << 8) | prog[i + 2]) << 16 >> 16); i += 3; }
            else if (b <= 246) { stack.push(b - 139); i++; }
            else if (b <= 250) { stack.push((b - 247) * 256 + prog[i + 1] + 108); i += 2; }
            else if (b <= 254) { stack.push(-(b - 251) * 256 - prog[i + 1] - 108); i += 2; }
            else { // 255 fixed
              let v = (prog[i + 1] << 24) | (prog[i + 2] << 16) | (prog[i + 3] << 8) | prog[i + 4];
              stack.push((v / 65536)); i += 5;
            }
            continue;
          }
          if (b === 12) {
            const op = prog[i + 1];
            i += 2;
            let a, c2;
            switch (op) {
              case 3: c2 = stack.pop(); a = stack.pop(); stack.push(a && c2 ? 1 : 0); break;
              case 4: c2 = stack.pop(); a = stack.pop(); stack.push(a || c2 ? 1 : 0); break;
              case 5: a = stack.pop(); stack.push(a ? 0 : 1); break;
              case 9: a = stack.pop(); stack.push(Math.abs(a)); break;
              case 10: c2 = stack.pop(); a = stack.pop(); stack.push(a + c2); break;
              case 11: c2 = stack.pop(); a = stack.pop(); stack.push(a - c2); break;
              case 12: c2 = stack.pop(); a = stack.pop(); stack.push(c2 === 0 ? 0 : a / c2); break;
              case 14: a = stack.pop(); stack.push(-a); break;
              case 15: c2 = stack.pop(); a = stack.pop(); stack.push(a === c2 ? 1 : 0); break;
              case 18: stack.pop(); break;
              case 20: a = stack.pop(); c2 = stack.pop(); stack[c2] = a; break;
              case 21: a = stack.pop(); c2 = stack.pop(); break;
              case 22: c2 = stack.pop(); a = stack.pop(); c2 = stack.pop(); stack.push(c2 ? a : c2); break;
              case 23: stack.push(0.5); break;
              case 24: c2 = stack.pop(); a = stack.pop(); stack.push(a * c2); break;
              case 26: a = stack.pop(); stack.push(a < 0 ? 0 : Math.sqrt(a)); break;
              case 27: a = stack.pop(); stack.push(a); stack.push(a); break;
              case 28: a = stack.pop(); c2 = stack.pop(); stack.push(c2); stack.push(a); break;
              case 29: {
                const idx = stack.pop();
                a = stack.pop();
                stack.push(idx < 0 ? a : stack[stack.length - 1 - idx]);
                break;
              }
              case 30: {
                const j = stack.pop(), n = stack.pop();
                for (let k = 0; k < j; k++) { const t = stack.pop(); stack.splice(stack.length - n, 0, t); }
                break;
              }
            }
            continue;
          }
          i++;
          switch (b) {
            case 1: case 3: case 18: case 23: {
              let args = stack.length;
              if (args % 2 === 1 && !haveWidth) { width = widthBase.nominalWidthX + stack.shift(); haveWidth = true; args--; }
              nStems += args / 2;
              stack.length = 0;
              break;
            }
            case 19: case 20: {
              let args = stack.length;
              if (!haveWidth && args % 2 === 1) { width = widthBase.nominalWidthX + stack.shift(); haveWidth = true; args--; }
              nStems += args / 2;
              stack.length = 0;
              i += Math.ceil(nStems / 8);
              break;
            }
            case 21: {
              let dx = 0, dy = 0;
              if (stack.length > 2 && !haveWidth) { width = widthBase.nominalWidthX + stack.shift(); haveWidth = true; }
              if (stack.length >= 2) { dx = stack[0]; dy = stack[1]; }
              moveTo(x + dx, y + dy); stack.length = 0; break;
            }
            case 22: {
              let dx = 0;
              if (stack.length > 1 && !haveWidth) { width = widthBase.nominalWidthX + stack.shift(); haveWidth = true; }
              dx = stack[0] || 0;
              moveTo(x + dx, y); stack.length = 0; break;
            }
            case 4: {
              let dy = 0;
              if (stack.length > 1 && !haveWidth) { width = widthBase.nominalWidthX + stack.shift(); haveWidth = true; }
              dy = stack[0] || 0;
              moveTo(x, y + dy); stack.length = 0; break;
            }
            case 5: {
              for (let k = 0; k + 1 < stack.length; k += 2) lineTo(x + stack[k], y + stack[k + 1]);
              stack.length = 0; break;
            }
            case 6: case 7: {
              let horiz = b === 6;
              for (let k = 0; k < stack.length; k++) {
                if (horiz) lineTo(x + stack[k], y); else lineTo(x, y + stack[k]);
                horiz = !horiz;
              }
              stack.length = 0; break;
            }
            case 8: {
              for (let k = 0; k + 5 < stack.length; k += 6) {
                curveTo(x + stack[k], y + stack[k + 1], x + stack[k] + stack[k + 2], y + stack[k + 1] + stack[k + 3], x + stack[k] + stack[k + 2] + stack[k + 4], y + stack[k + 1] + stack[k + 3] + stack[k + 5]);
              }
              stack.length = 0; break;
            }
            case 24: {
              let k = 0;
              for (; k + 5 < stack.length - 2; k += 6) {
                curveTo(x + stack[k], y + stack[k + 1], x + stack[k] + stack[k + 2], y + stack[k + 1] + stack[k + 3], x + stack[k] + stack[k + 2] + stack[k + 4], y + stack[k + 1] + stack[k + 3] + stack[k + 5]);
              }
              if (k + 1 < stack.length) lineTo(x + stack[k], y + stack[k + 1]);
              stack.length = 0; break;
            }
            case 25: {
              let k = 0;
              for (; k + 1 < stack.length - 6; k += 2) lineTo(x + stack[k], y + stack[k + 1]);
              if (k + 5 < stack.length) {
                curveTo(x + stack[k], y + stack[k + 1], x + stack[k] + stack[k + 2], y + stack[k + 1] + stack[k + 3], x + stack[k] + stack[k + 2] + stack[k + 4], y + stack[k + 1] + stack[k + 3] + stack[k + 5]);
              }
              stack.length = 0; break;
            }
            case 26: {
              let k = 0, dx1 = 0;
              if (stack.length % 4 >= 1) { dx1 = stack[0]; k = 1; }
              for (; k + 3 < stack.length; k += 4) {
                curveTo(x + dx1, y + stack[k], x + dx1 + stack[k + 1], y + stack[k] + stack[k + 2], x + dx1 + stack[k + 1], y + stack[k] + stack[k + 2] + stack[k + 3]);
                dx1 = 0;
              }
              stack.length = 0; break;
            }
            case 27: {
              let k = 0, dy1 = 0;
              if (stack.length % 4 >= 1) { dy1 = stack[0]; k = 1; }
              for (; k + 3 < stack.length; k += 4) {
                curveTo(x + stack[k], y + dy1, x + stack[k] + stack[k + 1], y + dy1 + stack[k + 2], x + stack[k] + stack[k + 1] + stack[k + 3], y + dy1 + stack[k + 2]);
                dy1 = 0;
              }
              stack.length = 0; break;
            }
            case 30: case 31: {
              const horiz = b === 30;
              let k = 0;
              let flip = horiz;
              while (k + 3 < stack.length) {
                if (flip) {
                  // vh: dx1 dy1 dx2 dy2 dy3
                  const dx1 = stack[k], dy1 = stack[k + 1], dx2 = stack[k + 2], dy2 = stack[k + 3];
                  if (k + 4 < stack.length) {
                    const dy3 = stack[k + 4];
                    curveTo(x + dx1, y + dy1, x + dx1 + dx2, y + dy1 + dy2, x + dx1 + dx2 + 0, y + dy1 + dy2 + dy3);
                    k += 5;
                  } else {
                    curveTo(x + dx1, y + dy1, x + dx1 + dx2, y + dy1 + dy2, x + dx1 + dx2, y + dy1 + dy2);
                    k += 4;
                  }
                } else {
                  const dy1 = stack[k], dx1 = stack[k + 1], dy2 = stack[k + 2], dx2 = stack[k + 3];
                  if (k + 4 < stack.length) {
                    const dx3 = stack[k + 4];
                    curveTo(x + dx1, y + dy1, x + dx1 + dx2, y + dy1 + dy2, x + dx1 + dx2 + dx3, y + dy1 + dy2);
                    k += 5;
                  } else {
                    curveTo(x + dx1, y + dy1, x + dx1 + dx2, y + dy1 + dy2, x + dx1 + dx2, y + dy1 + dy2);
                    k += 4;
                  }
                }
                flip = !flip;
              }
              stack.length = 0; break;
            }
            case 10: {
              const idx = stack.pop();
              const prog2 = arr[idx + bias];
              if (prog2 && callDepth < 10) { callDepth++; exec(prog2, true); callDepth--; }
              break;
            }
            case 29: {
              const idx = stack.pop();
              const prog2 = this.gsubrs.arr[idx + this.gsubrs.bias];
              if (prog2 && callDepth < 10) { callDepth++; exec(prog2, true); callDepth--; }
              break;
            }
            case 11: return;
            case 14: {
              if (stack.length >= 4 && !cur) {
                // seac 形式，忽略
              }
              stack.length = 0;
              return;
            }
            default:
              stack.length = 0;
          }
        }
      }
      exec(cs, false);
      const adv = width === null ? widthBase.defaultWidthX : width;
      return { contours: paths.filter(p => p.length), advance: adv };
    }
  }

  /** 三次贝塞尔 → 二次（递归细分，误差小） */
  function cubicToQuads(x0, y0, x1, y1, x2, y2, x3, y3, out) {
    const tol = 1.2;
    const rec = (x0, y0, x1, y1, x2, y2, x3, y3, depth) => {
      const ax = x3 - x0, ay = y3 - y0;
      const len2 = ax * ax + ay * ay;
      let d1, d2;
      if (len2 < 1e-6) {
        d1 = Math.hypot(x1 - x0, y1 - y0);
        d2 = Math.hypot(x2 - x0, y2 - y0);
      } else {
        d1 = Math.abs((x1 - x0) * ay - (y1 - y0) * ax) / Math.sqrt(len2);
        d2 = Math.abs((x2 - x0) * ay - (y2 - y0) * ax) / Math.sqrt(len2);
      }
      if ((d1 < tol && d2 < tol) || depth > 7) {
        // 单段二次逼近
        const qx = (3 * (x1 + x2) - (x0 + x3)) / 4;
        const qy = (3 * (y1 + y2) - (y0 + y3)) / 4;
        out.push({ x: qx, y: qy, on: false });
        out.push({ x: x3, y: y3, on: true });
        return;
      }
      const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
      const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
      const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
      const x012 = (x01 + x12) / 2, y012 = (y01 + y12) / 2;
      const x123 = (x12 + x23) / 2, y123 = (y12 + y23) / 2;
      const xm = (x012 + x123) / 2, ym = (y012 + y123) / 2;
      rec(x0, y0, x01, y01, x012, y012, xm, ym, depth + 1);
      rec(xm, ym, x123, y123, x23, y23, x3, y3, depth + 1);
    };
    rec(x0, y0, x1, y1, x2, y2, x3, y3, 0);
  }

  /* ---------------------------------------------------------------
   *  Face —— 单个字面
   * --------------------------------------------------------------- */
  class Face {
    constructor(bytes, offset) {
      this.bytes = bytes;
      this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.offset = offset;
      this.sfntVersion = this.dv.getUint32(offset);
      this.isOTF = this.sfntVersion === 0x4f54544f;
      const n = this.dv.getUint16(offset + 4);
      this.tables = {};
      for (let i = 0; i < n; i++) {
        const rec = offset + 12 + i * 16;
        const tag = readTag(this.dv, rec);
        this.tables[tag] = {
          offset: this.dv.getUint32(rec + 8),
          length: this.dv.getUint32(rec + 12),
          checksum: this.dv.getUint32(rec + 4)
        };
      }
      this._parseHead();
      this._parseHhea();
      this._parseMaxp();
      this._parseNames();
      this._cmapMap = null;
      this._reverseCmap = null;
      this._advances = null;
      this._lsbs = null;
      this._glyphCache = new Map();
      this._cff = null;
    }
    get cmap() {
      if (!this._cmapMap) this._parseCmap();
      return this._cmapMap;
    }
    get reverseCmap() {
      if (!this._reverseCmap) this._parseCmap();
      return this._reverseCmap;
    }
    get advances() {
      if (!this._advances) this._parseHmtx();
      return this._advances;
    }
    get lsbs() {
      if (!this._lsbs) this._parseHmtx();
      return this._lsbs;
    }

    /* ---- 基础表 ---- */
    _parseHead() {
      const t = this.tables.head;
      this.upem = this.dv.getUint16(t.offset + 18);
      this.indexToLocFormat = this.dv.getInt16(t.offset + 50);
      this.headRaw = this.tableBytes('head');
    }
    _parseHhea() {
      const t = this.tables.hhea;
      this.ascender = this.dv.getInt16(t.offset + 4);
      this.descender = this.dv.getInt16(t.offset + 6);
      this.lineGap = this.dv.getInt16(t.offset + 8);
      this.numHMetrics = this.dv.getUint16(t.offset + 34);
    }
    _parseMaxp() {
      this.numGlyphs = this.dv.getUint16(this.tables.maxp.offset + 4);
    }
    _parseHmtx() {
      const t = this.tables.hmtx;
      const adv = new Uint16Array(this.numGlyphs);
      const lsb = new Int16Array(this.numGlyphs);
      let last = 0;
      for (let i = 0; i < this.numGlyphs; i++) {
        if (i < this.numHMetrics) {
          last = this.dv.getUint16(t.offset + i * 4);
          adv[i] = last;
          lsb[i] = this.dv.getInt16(t.offset + i * 4 + 2);
        } else {
          adv[i] = last;
          const p = t.offset + this.numHMetrics * 4 + (i - this.numHMetrics) * 2;
          lsb[i] = p + 2 <= t.offset + t.length ? this.dv.getInt16(p) : 0;
        }
      }
      this._advances = adv;
      this._lsbs = lsb;
    }
    _parseCmap() {
      const t = this.tables.cmap;
      this._cmapMap = new Map();
      this._reverseCmap = new Map();
      if (!t) return;
      const n = this.dv.getUint16(t.offset + 2);
      let best = null, bestScore = -1;
      for (let i = 0; i < n; i++) {
        const rec = t.offset + 4 + i * 8;
        const pid = this.dv.getUint16(rec), eid = this.dv.getUint16(rec + 2);
        const off = this.dv.getUint32(rec + 4);
        const fmt = this.dv.getUint16(t.offset + off);
        let score = 0;
        if (pid === 3 && eid === 10) score = 5;
        else if (pid === 3 && eid === 1 && fmt === 4) score = 4;
        else if (pid === 0 && fmt === 12) score = 3;
        else if (pid === 0 && fmt === 4) score = 2;
        else if (pid === 3 && eid === 0) score = 1;
        if (score > bestScore && (fmt === 4 || fmt === 12)) { bestScore = score; best = { off, fmt }; }
      }
      if (!best) {
        // 尝试 format 6 / 0
        for (let i = 0; i < n; i++) {
          const rec = t.offset + 4 + i * 8;
          const off = this.dv.getUint32(rec + 4);
          const fmt = this.dv.getUint16(t.offset + off);
          if (fmt === 6 || fmt === 0) { best = { off, fmt }; break; }
        }
      }
      if (!best) return;
      const base = t.offset + best.off;
      if (best.fmt === 4) {
        const segX2 = this.dv.getUint16(base + 6);
        const seg = segX2 / 2;
        const endP = base + 14;
        const startP = endP + segX2 + 2;
        const deltaP = startP + segX2;
        const rangeP = deltaP + segX2;
        for (let s = 0; s < seg; s++) {
          const start = this.dv.getUint16(startP + s * 2);
          const end = this.dv.getUint16(endP + s * 2);
          const delta = this.dv.getInt16(deltaP + s * 2);
          const ro = this.dv.getUint16(rangeP + s * 2);
          if (start === 0xffff) continue;
          for (let c = start; c <= end && c !== 0xffff; c++) {
            let gid;
            if (ro === 0) {
              gid = (c + delta) & 0xffff;
            } else {
              const p = rangeP + s * 2 + ro + (c - start) * 2;
              if (p + 2 > this.tables.cmap.offset + t.length) continue;
              gid = this.dv.getUint16(p);
              if (gid !== 0) gid = (gid + delta) & 0xffff;
            }
            if (gid !== 0 && !this._cmapMap.has(c)) this._cmapMap.set(c, gid);
          }
        }
      } else if (best.fmt === 12) {
        const nGroups = this.dv.getUint32(base + 12);
        for (let g = 0; g < nGroups; g++) {
          const p = base + 16 + g * 12;
          const sc = this.dv.getUint32(p), ec = this.dv.getUint32(p + 4), sg = this.dv.getUint32(p + 8);
          for (let c = sc; c <= ec; c++) {
            const gid = sg + (c - sc);
            if (gid !== 0 && gid < this.numGlyphs && !this._cmapMap.has(c)) this._cmapMap.set(c, gid);
          }
        }
      } else if (best.fmt === 6) {
        const first = this.dv.getUint16(base + 6), cnt = this.dv.getUint16(base + 8);
        for (let i = 0; i < cnt; i++) {
          const gid = this.dv.getUint16(base + 10 + i * 2);
          if (gid) this._cmapMap.set(first + i, gid);
        }
      } else if (best.fmt === 0) {
        for (let i = 0; i < 256; i++) {
          const gid = this.dv.getUint8(base + 6 + i);
          if (gid) this._cmapMap.set(i, gid);
        }
      }
      for (const [cp, gid] of this._cmapMap) {
        if (!this._reverseCmap.has(gid)) this._reverseCmap.set(gid, cp);
      }
    }
    _parseNames() {
      const t = this.tables.name;
      this.names = {};
      if (!t) return;
      try {
        const count = this.dv.getUint16(t.offset + 2);
        const strOff = this.dv.getUint16(t.offset + 4);
        for (let i = 0; i < count; i++) {
          const rec = t.offset + 6 + i * 12;
          const pid = this.dv.getUint16(rec), lid = this.dv.getUint16(rec + 4);
          const nameId = this.dv.getUint16(rec + 6);
          const len = this.dv.getUint16(rec + 8), off = this.dv.getUint16(rec + 10);
          const p = t.offset + strOff + off;
          let s = '';
          if (pid === 3 || pid === 0) {
            for (let k = 0; k + 1 < len; k += 2) {
              const c = this.dv.getUint16(p + k);
              if (c) s += String.fromCharCode(c);
            }
          } else {
            for (let k = 0; k < len; k++) s += String.fromCharCode(this.dv.getUint8(p + k));
          }
          const pref = this.names[nameId];
          // 优先英文（Windows 0x409 / Mac 0）
          if (!pref || (lid === 0x409 || (pid === 1 && lid === 0))) this.names[nameId] = s;
        }
      } catch (e) { /* 忽略 */ }
      this.familyName = this.names[16] || this.names[1] || '未命名字体';
      this.subfamilyName = this.names[17] || this.names[2] || 'Regular';
      this.fullName = this.names[4] || (this.familyName + ' ' + this.subfamilyName);
      this.psName = this.names[6] || this.fullName.replace(/\s/g, '');
      this.versionName = this.names[5] || '';
    }

    get flavor() { return this.isOTF ? 'otf' : 'ttf'; }
    get charCount() { return this.cmap.size; }

    tableBytes(tag) {
      const t = this.tables[tag];
      if (!t) return null;
      return this.bytes.subarray(t.offset, t.offset + t.length);
    }

    /* ---- loca ---- */
    _loca() {
      if (this._locaArr) return this._locaArr;
      const t = this.tables.loca;
      const arr = new Int32Array(this.numGlyphs + 1);
      if (this.indexToLocFormat === 0) {
        for (let i = 0; i <= this.numGlyphs; i++) arr[i] = this.dv.getUint16(t.offset + i * 2) * 2;
      } else {
        for (let i = 0; i <= this.numGlyphs; i++) arr[i] = this.dv.getUint32(t.offset + i * 4);
      }
      this._locaArr = arr;
      return arr;
    }

    gidOf(cp) { return this.cmap.get(cp) || 0; }
    advanceOf(gid) { return this.advances[gid] || 0; }

    /* ---- 字形读取 ---- */
    getGlyph(gid) {
      if (this._glyphCache.has(gid)) return this._glyphCache.get(gid);
      let res;
      if (this.isOTF) {
        if (!this._cff) this._cff = new CFFFont(this);
        const p = this._cff.getPath(gid);
        res = { contours: p.contours, advance: p.advance || this.advances[gid] || 0 };
      } else {
        res = this._readGlyf(gid, 0);
      }
      this._glyphCache.set(gid, res);
      return res;
    }

    _readGlyf(gid, depth) {
      const loca = this._loca();
      const start = loca[gid], end = loca[gid + 1];
      const adv = this.advances[gid] || 0;
      if (end <= start) return { contours: [], advance: adv };
      const t = this.tables.glyf;
      const p0 = t.offset + start;
      const nContours = this.dv.getInt16(p0);
      if (nContours >= 0) {
        let p = p0 + 10;
        const endPts = [];
        for (let i = 0; i < nContours; i++) { endPts.push(this.dv.getUint16(p)); p += 2; }
        const instrLen = this.dv.getUint16(p); p += 2 + instrLen;
        const nPts = nContours ? endPts[nContours - 1] + 1 : 0;
        const flags = [];
        while (flags.length < nPts) {
          const f = this.dv.getUint8(p++);
          flags.push(f);
          if (f & 8) {
            const rep = this.dv.getUint8(p++);
            for (let k = 0; k < rep; k++) flags.push(f);
          }
        }
        const xs = new Int32Array(nPts);
        let x = 0;
        for (let i = 0; i < nPts; i++) {
          const f = flags[i];
          if (f & 2) {
            const v = this.dv.getUint8(p++);
            x += (f & 16) ? v : -v;
          } else if (!(f & 16)) {
            x += this.dv.getInt16(p); p += 2;
          }
          xs[i] = x;
        }
        const ys = new Int32Array(nPts);
        let y = 0;
        for (let i = 0; i < nPts; i++) {
          const f = flags[i];
          if (f & 4) {
            const v = this.dv.getUint8(p++);
            y += (f & 32) ? v : -v;
          } else if (!(f & 32)) {
            y += this.dv.getInt16(p); p += 2;
          }
          ys[i] = y;
        }
        const contours = [];
        let s = 0;
        for (let c = 0; c < nContours; c++) {
          const e = endPts[c];
          const arr = [];
          for (let i = s; i <= e; i++) arr.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
          contours.push(arr);
          s = e + 1;
        }
        return { contours, advance: adv };
      }
      // 复合字形
      let p = p0 + 10;
      const contours = [];
      let useMetrics = false;
      let lastAdv = adv;
      let more = true;
      while (more) {
        const flags = this.dv.getUint16(p); p += 2;
        const childGid = this.dv.getUint16(p); p += 2;
        let dx, dy;
        if (flags & 1) { dx = this.dv.getInt16(p); dy = this.dv.getInt16(p + 2); p += 4; }
        else { dx = this.dv.getInt8(p); dy = this.dv.getInt8(p + 1); p += 2; }
        let a = 1, b = 0, c = 0, d = 1;
        if (flags & 8) { a = d = this.dv.getInt16(p) / 16384; p += 2; }
        else if (flags & 64) { a = this.dv.getInt16(p) / 16384; d = this.dv.getInt16(p + 2) / 16384; p += 4; }
        else if (flags & 128) {
          a = this.dv.getInt16(p) / 16384; b = this.dv.getInt16(p + 2) / 16384;
          c = this.dv.getInt16(p + 4) / 16384; d = this.dv.getInt16(p + 6) / 16384;
          p += 8;
        }
        if (flags & 512) useMetrics = true;
        if (depth < 5 && childGid < this.numGlyphs) {
          const child = this._readGlyf(childGid, depth + 1);
          for (const ct of child.contours) {
            contours.push(ct.map(pt => ({
              x: Math.round(a * pt.x + c * pt.y + dx),
              y: Math.round(b * pt.x + d * pt.y + dy),
              on: pt.on
            })));
          }
          if (useMetrics && flags & 512) lastAdv = child.advance;
        }
        more = !!(flags & 32);
      }
      return { contours, advance: lastAdv };
    }

    /** 把当前字面单独打包成标准单字体文件（用于浏览器预览） */
    standaloneBytes() {
      const tables = [];
      const skip = new Set();
      for (const tag in this.tables) {
        if (skip.has(tag)) continue;
        tables.push({ tag, data: new Uint8Array(this.tableBytes(tag)) });
      }
      return assembleSFNT(this.sfntVersion, tables, { fixHead: true });
    }
  }

  /* ---------------------------------------------------------------
   *  组装 SFNT
   * --------------------------------------------------------------- */
  function assembleSFNT(sfntVersion, tables, opts) {
    opts = opts || {};
    tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    const n = tables.length;
    let sr = 1, entrySel = 0;
    while (sr * 2 <= n) { sr *= 2; entrySel++; }
    const searchRange = sr * 16, rangeShift = n * 16 - searchRange;
    let off = 12 + n * 16;
    const layout = [];
    for (const t of tables) {
      const data = t.data;
      const len = data.length;
      layout.push({ tag: t.tag, data, offset: off, length: len });
      off += (len + 3) & ~3;
    }
    const total = off;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, sfntVersion);
    dv.setUint16(4, n);
    dv.setUint16(6, searchRange);
    dv.setUint16(8, entrySel);
    dv.setUint16(10, rangeShift);
    // 先写数据
    for (const l of layout) out.set(l.data, l.offset);
    // head 清零调整位
    let headRef = null;
    if (opts.fixHead) {
      headRef = layout.find(l => l.tag === 'head');
      if (headRef) { dv.setUint32(headRef.offset + 8, 0); }
    }
    // 目录
    let pos = 12;
    for (const l of layout) {
      out.set(tagBytes(l.tag), pos);
      const sum = checksum(out, l.offset, l.offset + l.length);
      dv.setUint32(pos + 4, sum);
      dv.setUint32(pos + 8, l.offset);
      dv.setUint32(pos + 12, l.length);
      pos += 16;
    }
    if (headRef) {
      const adj = (0xb1b0afba - checksum(out, 0, total)) >>> 0;
      dv.setUint32(headRef.offset + 8, adj);
    }
    return out;
  }

  /* ---------------------------------------------------------------
   *  字形编码（TrueType simple glyph）
   * --------------------------------------------------------------- */
  function contourBBox(contours) {
    if (!contours || !contours.length) return null;
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const c of contours) for (const p of c) {
      if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
    }
    if (!isFinite(xMin)) return null;
    return { xMin: Math.round(xMin), yMin: Math.round(yMin), xMax: Math.round(xMax), yMax: Math.round(yMax) };
  }

  function encodeGlyph(contours, bbox) {
    if (!contours || !contours.length) return new Uint8Array(0);
    const flat = [];
    const endPts = [];
    for (const c of contours) {
      if (!c.length) continue;
      for (const p of c) flat.push(p);
      endPts.push(flat.length - 1);
    }
    if (!flat.length) return new Uint8Array(0);
    const nContours = endPts.length;
    const bb = bbox || contourBBox(contours) || { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    const buf = new Buf(flat.length * 3 + 40);
    buf.i16(nContours);
    buf.i16(bb.xMin); buf.i16(bb.yMin); buf.i16(bb.xMax); buf.i16(bb.yMax);
    for (const e of endPts) buf.u16(e);
    buf.u16(0); // no instructions
    // flags & coords
    const flags = new Uint8Array(flat.length);
    const xs = [], ys = [];
    let px = 0, py = 0;
    for (let i = 0; i < flat.length; i++) {
      const p = flat[i];
      const x = Math.round(p.x), y = Math.round(p.y);
      let f = p.on ? 1 : 0;
      const dx = x - px, dy = y - py;
      if (dx === 0) { f |= 0x10; }
      else if (dx > -256 && dx < 256) { f |= 0x02; if (dx > 0) f |= 0x10; xs.push(Math.abs(dx)); }
      else xs.push(dx);
      if (dy === 0) { f |= 0x20; }
      else if (dy > -256 && dy < 256) { f |= 0x04; if (dy > 0) f |= 0x20; ys.push(Math.abs(dy)); }
      else ys.push(dy);
      flags[i] = f;
      px = x; py = y;
    }
    // 压缩重复 flags
    for (let i = 0; i < flags.length; i++) {
      let run = 1;
      while (i + run < flags.length && flags[i + run] === flags[i] && run < 255) run++;
      if (run > 1) { buf.u8(flags[i] | 0x08); buf.u8(run - 1); i += run - 1; }
      else buf.u8(flags[i]);
    }
    // x 坐标
    let xi = 0, yi = 0;
    for (let i = 0; i < flat.length; i++) {
      const f = flags[i];
      if (f & 0x02) buf.u8(xs[xi++]);
      else if (!(f & 0x10)) { buf.i16(xs[xi]); xi++; }
    }
    for (let i = 0; i < flat.length; i++) {
      const f = flags[i];
      if (f & 0x04) buf.u8(ys[yi++]);
      else if (!(f & 0x20)) { buf.i16(ys[yi]); yi++; }
    }
    return buf.out();
  }

  /* ---------------------------------------------------------------
   *  cmap 构建
   * --------------------------------------------------------------- */
  function buildCmap(mapping) {
    // mapping: Map cp -> gid
    const entries = [...mapping.entries()].filter(([cp, gid]) => cp >= 0 && gid > 0 && gid < 0xffff && cp <= 0x10ffff);
    entries.sort((a, b) => a[0] - b[0]);

    // ---- format 4（BMP） ----
    const bmp = entries.filter(([cp]) => cp <= 0xffff);
    let segs = [];
    let last = null;
    for (const [cp, gid] of bmp) {
      const delta = ((gid - cp + 0x10000) & 0xffff);
      if (last && cp === last.end + 1 && delta === last.delta) last.end = cp;
      else { last = { start: cp, end: cp, delta }; segs.push(last); }
    }
    segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
    const segCount = segs.length;
    let sr = 1, es = 0;
    while (sr * 2 <= segCount) { sr *= 2; es++; }
    const b4 = new Buf(16 + segCount * 8);
    b4.u16(4); b4.u16(16 + segCount * 8); b4.u16(0);
    b4.u16(segCount * 2); b4.u16(sr * 2); b4.u16(es); b4.u16(segCount * 2 - sr * 2);
    for (const s of segs) b4.u16(s.end);
    b4.u16(0);
    for (const s of segs) b4.u16(s.start);
    for (const s of segs) b4.i16(s.delta);
    for (const s of segs) b4.u16(0);
    pad4(b4);

    // ---- format 12（全平面） ----
    const groups = [];
    let g = null;
    for (const [cp, gid] of entries) {
      if (g && cp === g.end + 1 && gid === g.gid + (cp - g.start)) g.end = cp;
      else { g = { start: cp, end: cp, gid }; groups.push(g); }
    }
    const b12 = new Buf(16 + groups.length * 12);
    b12.u16(12); b12.u16(0); b12.u32(16 + groups.length * 12); b12.u32(0);
    b12.u32(groups.length);
    for (const gr of groups) { b12.u32(gr.start); b12.u32(gr.end); b12.u32(gr.gid); }
    pad4(b12);

    // ---- 合并子表 ----
    const headerLen = 20;
    const sub4Off = headerLen;
    const sub12Off = sub4Off + b4.length;
    const out = new Buf(sub12Off + b12.length);
    out.u16(0); out.u16(2);
    out.u16(3); out.u16(1); out.u32(sub4Off);
    out.u16(3); out.u16(10); out.u32(sub12Off);
    out.bytes(b4.out());
    out.bytes(b12.out());
    return out.out();
  }

  /* ---------------------------------------------------------------
   *  post 表扩展（保留原有字形名）
   * --------------------------------------------------------------- */
  function extendPost(face, newCount) {
    const raw = face.tableBytes('post');
    if (!raw) return null;
    const version = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
    if (version !== 0x00020000 || raw.length < 34) return new Uint8Array(raw);
    const origCount = (raw[32] << 8) | raw[33];
    const idxBytes = raw.subarray(34, 34 + origCount * 2);
    const strStart = 34 + origCount * 2;
    const strData = raw.subarray(strStart);
    let maxIdx = 257;
    for (let i = 0; i < origCount; i++) {
      const v = (idxBytes[i * 2] << 8) | idxBytes[i * 2 + 1];
      if (v > maxIdx) maxIdx = v;
    }
    const newNames = [];
    for (let i = origCount; i < newCount; i++) newNames.push('.pfnew' + i);
    const buf = new Buf(raw.length + (newCount - origCount) * 2 + newNames.length * 12 + 64);
    buf.bytes(raw.subarray(0, 32));
    buf.u16(newCount);
    buf.bytes(idxBytes);
    let nextIdx = maxIdx + 1;
    for (let i = 0; i < newNames.length; i++) buf.u16(nextIdx++);
    buf.bytes(strData);
    for (const s of newNames) {
      const cut = s.slice(0, 255);
      buf.u8(cut.length);
      for (let k = 0; k < cut.length; k++) buf.u8(cut.charCodeAt(k) & 0xff);
    }
    return buf.out();
  }

  /* ---------------------------------------------------------------
   *  轮廓变换
   * --------------------------------------------------------------- */
  function transformContours(contours, upem, style, advance) {
    const scale = (style.scale === undefined ? 100 : style.scale) / 100;
    const dyUnits = ((style.dy || 0) / 1000) * upem;
    const shade = style.shade === undefined ? 100 : style.shade;
    // 粗细：每侧推开的距离。浓淡用同一套机制做「变细」，<100 就轻，100 保持原样
    const weightUnits = ((style.weight || 0) / 1000) * upem / 2 + ((shade - 100) / 100) * (upem / 30);
    if (scale === 1 && dyUnits === 0 && weightUnits === 0 && !style.center) return contours;
    let out = contours.map(c => c.map(p => ({ x: p.x * scale, y: p.y * scale + dyUnits, on: p.on })));
    if (weightUnits) {
      out = out.map(c => {
        const n = c.length;
        if (n < 2) return c;
        // 真字体里外框与孔的方向相反：按轮廓面积定方向，外框向外、孔向内
        let area = 0;
        for (let i = 0; i < n; i++) {
          const p = c[i], q = c[(i + 1) % n];
          area += p.x * q.y - q.x * p.y;
        }
        const dir = area < 0 ? -1 : 1;
        return c.map((p, i) => {
          const prev = c[(i + n - 1) % n], next = c[(i + 1) % n];
          const dx = next.x - prev.x, dy = next.y - prev.y;
          const len = Math.hypot(dx, dy) || 1;
          return { x: p.x + dir * (dy / len) * weightUnits, y: p.y - dir * (dx / len) * weightUnits, on: p.on };
        });
      });
    }
    if (style.center && advance) {
      let x0 = Infinity, x1 = -Infinity;
      for (const c of out) for (const p of c) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; }
      if (x0 !== Infinity) {
        const dx = advance / 2 - (x0 + x1) / 2;
        out = out.map(c => c.map(p => ({ x: p.x + dx, y: p.y, on: p.on })));
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------
   *  构建字体
   * --------------------------------------------------------------- */
  /**
   * plan = {
   *   overrides: Map<gid, {contours, advance}>,   // 覆盖字形
   *   empties:   Set<gid>,                        // 清空字形（保留 0 宽度）
   *   appended:  [{cp, contours, advance}],       // 新增字符
   *   styles:    Map<cp, style>,                  // 字符级样式（烘焙进轮廓）
   *   colors:    Map<cp, {r,g,b,a}>,              // 颜色（COLR）
   *   lineGap:   number|null,
   *   dropCmapCp: Set<cp>                         // 移除映射
   * }
   */
  function buildTables(face, plan, onProgress) {
    plan = plan || {};
    const overrides = plan.overrides || new Map();
    const empties = plan.empties || new Set();
    const appended = plan.appended || [];
    const styles = plan.styles || new Map();
    const colors = plan.colors || new Map();
    const dropCp = plan.dropCmapCp || new Set();

    const baseCount = face.numGlyphs;
    const remap = new Map();          // cp -> gid（最终）
    for (const [cp, gid] of face.cmap) {
      if (!dropCp.has(cp)) remap.set(cp, gid);
    }
    // 需要新增的字符
    const appendedByCp = new Map();
    appended.forEach((a, i) => {
      const gid = baseCount + i;
      remap.set(a.cp, gid);
      appendedByCp.set(a.cp, { gid, entry: a });
    });
    // 颜色层字形
    const colorLayers = [];           // {baseGid, layerGid, paletteIndex}
    const palette = [];
    const paletteLookup = new Map();
    let nextGid = baseCount + appended.length;

    // 计算每个字形最终轮廓
    const finalCount = baseCount + appended.length + (colors.size * 2);
    const glyphData = new Array(finalCount).fill(null); // null = 原样复制
    const advances = new Array(finalCount).fill(0);

    // 1) 结构编辑
    for (let gid = 0; gid < baseCount; gid++) {
      advances[gid] = face.advances[gid] || 0;
      if (empties.has(gid)) { glyphData[gid] = []; advances[gid] = 0; }
      else if (overrides.has(gid)) {
        const o = overrides.get(gid);
        glyphData[gid] = o.contours || [];
        if (o.advance !== undefined) advances[gid] = o.advance;
      }
    }
    for (let i = 0; i < appended.length; i++) {
      glyphData[baseCount + i] = appended[i].contours || [];
      advances[baseCount + i] = appended[i].advance || 0;
    }

    // 2) 样式（按 gid 烘焙，整面样式不依赖 cmap，TTC 各字面共同生效）
    const applyStyleTo = (gid, style) => {
      if (!style || !style.dirty) return;
      let contours;
      if (glyphData[gid]) contours = glyphData[gid];
      else if (gid < baseCount) contours = face.getGlyph(gid).contours;
      else return;
      if (!contours.length) return;
      const upem = face.upem;
      const sc = (style.scale === undefined ? 100 : style.scale) / 100;
      const trackUnits = ((style.tracking || 0) / 1000) * upem;
      const finalAdv = Math.round(advances[gid] * sc + trackUnits);
      glyphData[gid] = transformContours(contours, upem, style, finalAdv);
      advances[gid] = finalAdv;
    };
    if (plan.globalStyle) {
      for (let gid = 0; gid < baseCount + appended.length; gid++) applyStyleTo(gid, plan.globalStyle);
    }
    for (const [cp, style] of styles) {
      const gid = remap.get(cp);
      if (gid === undefined) continue;
      applyStyleTo(gid, style);
    }

    // 3) 颜色层
    const baseGidsColored = [];
    const coloredSet = new Set();
    for (const [cp, col] of colors) {
      const gid = remap.get(cp);
      if (gid === undefined || coloredSet.has(gid)) continue;
      coloredSet.add(gid);
      const key = col.r + ',' + col.g + ',' + col.b + ',' + col.a;
      let pi = paletteLookup.get(key);
      if (pi === undefined) { pi = palette.length; palette.push(col); paletteLookup.set(key, pi); }
      // 层字形
      const layerGid = nextGid++;
      let contours = glyphData[gid] || (gid < baseCount ? face.getGlyph(gid).contours : []);
      glyphData[layerGid] = contours;
      advances[layerGid] = advances[gid];
      colorLayers.push({ baseGid: gid, layerGid, paletteIndex: pi });
      baseGidsColored.push(gid);
    }
    // 整面颜色：给每个有轮廓的字形加一层同形色层
    if (plan.globalColor) {
      const col = plan.globalColor;
      const key = col.r + ',' + col.g + ',' + col.b + ',' + col.a;
      let pi = paletteLookup.get(key);
      if (pi === undefined) { pi = palette.length; palette.push(col); paletteLookup.set(key, pi); }
      for (let gid = 0; gid < baseCount; gid++) {
        if (coloredSet.has(gid) || empties.has(gid)) continue;
        const contours = glyphData[gid] || (gid < baseCount ? face.getGlyph(gid).contours : []);
        if (!contours.length) continue;
        const layerGid = nextGid++;
        glyphData[layerGid] = contours;
        advances[layerGid] = advances[gid];
        colorLayers.push({ baseGid: gid, layerGid, paletteIndex: pi });
        baseGidsColored.push(gid);
      }
    }

    // CFF 字体导出 TTF：需要先解码全部轮廓
    const totalGlyphs = nextGid;
    const hasColor = colorLayers.length > 0;
    if (face.isOTF) {
      for (let gid = 0; gid < totalGlyphs; gid++) {
        if (!glyphData[gid]) glyphData[gid] = face.getGlyph(gid).contours;
        if (onProgress && gid % 1500 === 0) onProgress(0.05 + 0.35 * (gid / Math.max(1, totalGlyphs)));
      }
    }

    // 4) 编码 glyf
    const glyfBuf = new Buf(Math.max(1024, (face.tables.glyf ? face.tables.glyf.length : 0) + 4096));
    const loca = new Uint32Array(totalGlyphs + 1);
    let maxPoints = 0, maxContours = 0;
    const bboxes = new Array(totalGlyphs);
    const touched = [];
    for (let gid = 0; gid < totalGlyphs; gid++) {
      loca[gid] = glyfBuf.length;
      const data = gid < glyphData.length ? glyphData[gid] : null;
      if (data) {
        const bbox = contourBBox(data);
        bboxes[gid] = bbox || { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
        let pts = 0;
        for (const c of data) pts += c.length;
        if (pts > maxPoints) maxPoints = pts;
        if (data.length > maxContours) maxContours = data.length;
        glyfBuf.bytes(encodeGlyph(data, bbox));
      } else if (gid < baseCount) {
        // 原样复制
        const arr = face._loca();
        const s = arr[gid], e = arr[gid + 1];
        if (e > s) {
          const t = face.tables.glyf;
          glyfBuf.bytes(face.bytes.subarray(t.offset + s, t.offset + e));
          const bb = {
            xMin: face.dv.getInt16(t.offset + s + 2), yMin: face.dv.getInt16(t.offset + s + 4),
            xMax: face.dv.getInt16(t.offset + s + 6), yMax: face.dv.getInt16(t.offset + s + 8)
          };
          bboxes[gid] = bb;
        } else {
          bboxes[gid] = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
        }
        touched.push(gid);
      }
      // 4 字节对齐（glyf 无要求，但保持一致）
      while (glyfBuf.length % 2) glyfBuf.u8(0);
      if (onProgress && gid % 4000 === 0) onProgress(gid / totalGlyphs * 0.7);
    }
    loca[totalGlyphs] = glyfBuf.length;
    const glyfData = glyfBuf.out();

    // 5) hmtx
    const hmtx = new Buf(totalGlyphs * 4);
    let advMax = 0;
    let minLsb = 32767, minRsb = 32767, maxExtent = -32768;
    for (let gid = 0; gid < totalGlyphs; gid++) {
      const adv = Math.max(0, Math.round(advances[gid]));
      const bb = bboxes[gid] || { xMin: 0, xMax: 0 };
      const lsb = bb.xMin;
      hmtx.u16(adv);
      hmtx.i16(lsb);
      if (adv > advMax) advMax = adv;
      if (lsb < minLsb) minLsb = lsb;
      const rsb = adv - adv - 0; // 占位
      const extent = lsb + (bb.xMax - bb.xMin);
      if (extent > maxExtent) maxExtent = extent;
      const r = adv - (lsb + (bb.xMax - bb.xMin));
      if (r < minRsb) minRsb = r;
    }

    // 6) 表组装
    const tables = [];
    const tableMap = {};
    for (const tag in face.tables) {
      if (['glyf', 'loca', 'hmtx', 'maxp', 'head', 'hhea', 'cmap', 'post', 'CFF ', 'CFF2', 'VORG', 'COLR', 'CPAL', 'DSIG', 'hdmx', 'LTSH', 'VDMX'].includes(tag)) continue;
      tables.push({ tag, data: new Uint8Array(face.tableBytes(tag)) });
    }

    // head
    const headData = new Uint8Array(face.tableBytes('head'));
    const hdv = new DataView(headData.buffer);
    let xMinAll = 32767, yMinAll = 32767, xMaxAll = -32768, yMaxAll = -32768;
    for (let gid = 0; gid < totalGlyphs; gid++) {
      const bb = bboxes[gid];
      if (!bb) continue;
      if (bb.xMin < xMinAll) xMinAll = bb.xMin;
      if (bb.yMin < yMinAll) yMinAll = bb.yMin;
      if (bb.xMax > xMaxAll) xMaxAll = bb.xMax;
      if (bb.yMax > yMaxAll) yMaxAll = bb.yMax;
    }
    if (xMinAll === 32767) { xMinAll = 0; yMinAll = 0; xMaxAll = 0; yMaxAll = 0; }
    hdv.setInt16(36, xMinAll); hdv.setInt16(38, yMinAll);
    hdv.setInt16(40, xMaxAll); hdv.setInt16(42, yMaxAll);
    hdv.setInt16(50, 1); // long loca
    hdv.setUint32(8, 0);
    tables.push({ tag: 'head', data: headData });

    // hhea
    const hheaData = new Uint8Array(face.tableBytes('hhea'));
    const hhdv = new DataView(hheaData.buffer);
    hhdv.setUint16(10, advMax);
    hhdv.setInt16(12, minLsb); hhdv.setInt16(14, minRsb); hhdv.setInt16(16, maxExtent);
    hhdv.setUint16(34, totalGlyphs);
    if (plan.lineGap !== null && plan.lineGap !== undefined) hhdv.setInt16(8, Math.round(plan.lineGap));
    tables.push({ tag: 'hhea', data: hheaData });

    // maxp
    const maxpRaw = new Uint8Array(face.tableBytes('maxp'));
    let maxpData;
    if (maxpRaw.length >= 32) {
      maxpData = maxpRaw;
      const mdv = new DataView(maxpData.buffer);
      mdv.setUint16(4, totalGlyphs);
      const curMaxPoints = mdv.getUint16(6), curMaxContours = mdv.getUint16(8);
      if (maxPoints > curMaxPoints) mdv.setUint16(6, maxPoints);
      if (maxContours > curMaxContours) mdv.setUint16(8, maxContours);
    } else {
      // CFF 的 maxp 0.5 → 重建为 1.0
      const b = new Buf(32);
      b.u32(0x00010000); b.u16(totalGlyphs);
      b.u16(maxPoints); b.u16(maxContours);
      b.u16(maxPoints); b.u16(maxContours); // 复合字形退化后不再使用
      b.u16(2); b.u16(0); b.u16(0); b.u16(0);
      b.u16(0); b.u16(0); b.u16(0); b.u16(0); b.u16(0);
      maxpData = b.out();
    }
    tables.push({ tag: 'maxp', data: maxpData });

    // loca
    const locaBuf = new Buf((totalGlyphs + 1) * 4);
    for (let i = 0; i <= totalGlyphs; i++) locaBuf.u32(loca[i]);
    tables.push({ tag: 'loca', data: locaBuf.out() });

    tables.push({ tag: 'glyf', data: glyfData });
    tables.push({ tag: 'hmtx', data: hmtx.out() });
    tables.push({ tag: 'cmap', data: buildCmap(remap) });

    // post
    const postData = extendPost(face, totalGlyphs, null);
    if (postData) tables.push({ tag: 'post', data: postData });

    // COLR / CPAL
    if (hasColor) {
      const cpal = new Buf(14 + palette.length * 4);
      cpal.u16(0); cpal.u16(palette.length); cpal.u16(1); cpal.u16(palette.length);
      cpal.u32(14);
      cpal.u16(0);
      for (const c of palette) { cpal.u8(c.b); cpal.u8(c.g); cpal.u8(c.r); cpal.u8(c.a === undefined ? 255 : c.a); }

      colorLayers.sort((a, b) => a.baseGid - b.baseGid);
      const colr = new Buf(14 + colorLayers.length * 6 + colorLayers.length * 4);
      colr.u16(0);
      colr.u16(colorLayers.length);
      const baseRecOff = 14;
      const layerRecOff = baseRecOff + colorLayers.length * 6;
      colr.u32(baseRecOff);
      colr.u32(layerRecOff);
      colr.u16(colorLayers.length);
      let firstIdx = 0;
      for (const l of colorLayers) {
        colr.u16(l.baseGid); colr.u16(firstIdx); colr.u16(1);
        firstIdx += 1;
      }
      for (const l of colorLayers) { colr.u16(l.layerGid); colr.u16(l.paletteIndex); }
      tables.push({ tag: 'COLR', data: colr.out() });
      tables.push({ tag: 'CPAL', data: cpal.out() });
    }

    if (onProgress) onProgress(0.95);
    return {
      tables,
      meta: {
        glyphCount: totalGlyphs,
        charCount: remap.size,
        editedCount: overrides.size + empties.size + appended.length + styles.size,
        colored: colorLayers.length,
        bbox: { xMin: xMinAll, yMin: yMinAll, xMax: xMaxAll, yMax: yMaxAll },
        baseHead: headData
      }
    };
  }

  function buildFont(face, plan, onProgress) {
    const built = buildTables(face, plan, onProgress);
    const bytes = assembleSFNT(0x00010000, built.tables, { fixHead: true });
    if (onProgress) onProgress(1);
    return {
      bytes,
      glyphCount: built.meta.glyphCount,
      charCount: built.meta.charCount,
      editedCount: built.meta.editedCount,
      colored: built.meta.colored,
      bbox: built.meta.bbox
    };
  }

  /* ---------------------------------------------------------------
   *  组装 TTC 合集（字面共享同一套轮廓表）
   * --------------------------------------------------------------- */
  const TTC_SHARED_TAGS = ['glyf', 'loca', 'hmtx', 'cmap', 'maxp', 'head', 'hhea', 'post'];

  function canShareTables(faces) {
    if (!faces || faces.length < 2) return false;
    return TTC_SHARED_TAGS.every(tag => {
      const t0 = faces[0].tables[tag];
      if (!t0) return false;
      return faces.every(f => {
        const t = f.tables[tag];
        return t && t.offset === t0.offset && t.length === t0.length;
      });
    });
  }

  // faceTables: [[{tag, data}, ...], ...]，表对象引用相同即共享同一份数据
  function assembleTTC(faceTables, onProgress) {
    const n = faceTables.length;
    const dirs = faceTables.map(t => t.slice().sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)));
    const headerSize = 12 + n * 4;
    let off = headerSize;
    const dirOffsets = [];
    for (const t of dirs) {
      dirOffsets.push(off);
      off += 12 + t.length * 16;
    }
    const pool = new Map(); // 表对象 -> 位置
    for (const t of dirs) {
      for (const tb of t) {
        if (pool.has(tb)) continue;
        off = (off + 3) & ~3;
        pool.set(tb, { offset: off, length: tb.data.length, sum: 0 });
        off += tb.data.length;
        off = (off + 3) & ~3;
      }
    }
    const total = off;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x74746366); // ttcf
    dv.setUint32(4, 0x00010000);
    dv.setUint32(8, n);
    for (let i = 0; i < n; i++) dv.setUint32(12 + i * 4, dirOffsets[i]);

    for (const [tb, p] of pool) out.set(tb.data, p.offset);
    for (const [tb, p] of pool) p.sum = checksum(out, p.offset, p.offset + p.length);

    // 各字面的 head 需要独立的 checkSumAdjustment
    const headOwners = new Map(); // head 表对象 -> 使用它的字面索引数组
    for (let i = 0; i < n; i++) {
      for (const tb of dirs[i]) {
        if (tb.tag !== 'head') continue;
        if (!headOwners.has(tb)) headOwners.set(tb, []);
        headOwners.get(tb).push(i);
      }
    }

    for (let i = 0; i < n; i++) {
      const tables = dirs[i];
      const dirOff = dirOffsets[i];
      const k = tables.length;
      let sr = 1, es = 0;
      while (sr * 2 <= k) { sr *= 2; es++; }
      dv.setUint32(dirOff, 0x00010000);
      dv.setUint16(dirOff + 4, k);
      dv.setUint16(dirOff + 6, sr * 16);
      dv.setUint16(dirOff + 8, es);
      dv.setUint16(dirOff + 10, k * 16 - sr * 16);
      let pos = dirOff + 12;
      for (const tb of tables) {
        const p = pool.get(tb);
        out.set(tagBytes(tb.tag), pos);
        dv.setUint32(pos + 4, p.sum);
        dv.setUint32(pos + 8, p.offset);
        dv.setUint32(pos + 12, p.length);
        pos += 16;
      }
      // checkSumAdjustment：以 head 调整位为 0 时的目录校验和 + 各表校验和
      const headTb = tables.find(t => t.tag === 'head');
      if (headTb) {
        let sum = checksum(out, dirOff, dirOff + 12 + k * 16);
        for (const tb of tables) sum = (sum + pool.get(tb).sum) >>> 0;
        const p = pool.get(headTb);
        const adj = (0xb1b0afba - sum) >>> 0;
        if (headOwners.get(headTb).length === 1) {
          dv.setUint32(p.offset + 8, adj);
          // 目录里 head 的校验和保持"调整位为 0"时的值（fontTools 与规范均如此）
        }
      }
      if (onProgress) onProgress(0.5 + 0.5 * ((i + 1) / n));
    }
    return out;
  }

  function buildCollection(faces, plan, onProgress) {
    if (!canShareTables(faces)) {
      throw new Error('该合集的字面各自拥有独立轮廓，无法合并导出');
    }
    const built = buildTables(faces[0], plan, onProgress);
    const shared = built.tables.filter(t => t.tag !== 'name' && t.tag !== 'OS/2' && t.tag !== 'head');
    const headTpl = built.meta.baseHead;
    const faceTables = faces.map(f => {
      const per = shared.slice();
      if (f.tables['name']) per.push({ tag: 'name', data: new Uint8Array(f.tableBytes('name')) });
      if (f.tables['OS/2']) per.push({ tag: 'OS/2', data: new Uint8Array(f.tableBytes('OS/2')) });
      per.push({ tag: 'head', data: new Uint8Array(headTpl) });
      return per;
    });
    const bytes = assembleTTC(faceTables, onProgress);
    if (onProgress) onProgress(1);
    return {
      bytes,
      faceCount: faces.length,
      glyphCount: built.meta.glyphCount,
      charCount: built.meta.charCount,
      editedCount: built.meta.editedCount,
      bbox: built.meta.bbox
    };
  }

  /* ---------------------------------------------------------------
   *  读取入口
   * --------------------------------------------------------------- */
  function parse(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const isTTC = bytes.length > 4 && readTag(dv, 0) === 'ttcf';
    const faces = [];
    if (isTTC) {
      const numFonts = dv.getUint32(8);
      for (let i = 0; i < numFonts; i++) {
        const off = dv.getUint32(12 + i * 4);
        try { faces.push(new Face(bytes, off)); } catch (e) { console.warn('字面解析失败', i, e); }
      }
    } else {
      faces.push(new Face(bytes, 0));
    }
    return {
      bytes, isCollection: isTTC, totalFaces: faces.length, faces,
      fileName: '',
      format: isTTC ? 'TTC' : (faces[0] ? (faces[0].isOTF ? 'OTF' : 'TTF') : '未知')
    };
  }

  const api = {
    parse, Face, buildFont, buildTables, buildCollection, assembleTTC, canShareTables,
    buildCmap, encodeGlyph, contourBBox, transformContours, assembleSFNT, Buf, checksum
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FontEngine = api;
})(typeof window !== 'undefined' ? window : this);
