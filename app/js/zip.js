/* Audabook — minimal ZIP writer/reader (stored, uncompressed; WAV audio barely compresses anyway).
   Used for "stems as one .zip" and for .audabook project files. */
(function (root) {
  'use strict';
  const SS = (root.SS = root.SS || {});

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  SS.crc32 = function (u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  const toBytes = (data) => (data instanceof Uint8Array ? data : new Uint8Array(data));
  const encodeName = (name) => new TextEncoder().encode(name);

  class ZipWriter {
    constructor() {
      this.parts = [];
      this.central = [];
      this.offset = 0;
      this.count = 0;
      this.names = new Set();
    }

    add(name, data) {
      const bytes = toBytes(data);
      if (this.names.has(name)) throw new Error('Duplicate zip entry ' + name);
      this.names.add(name);
      const nameBytes = encodeName(name);
      const crc = SS.crc32(bytes);
      const size = bytes.length;
      const { time, date } = dosDateTime(new Date());
      if (this.offset + 30 + nameBytes.length + size > 0xffffffff) {
        throw new SS.UserError('That is too much audio for one .zip file (over 4 GB). Try saving to a folder instead.');
      }

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // UTF-8 names
      lv.setUint16(8, 0, true); // stored
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      // extra, comment, disk, internal attrs, external attrs: all zero
      cv.setUint32(42, this.offset, true);
      cen.set(nameBytes, 46);

      // Wrapping the data in a Blob lets the browser park it outside JS memory (and on disk if large),
      // so the caller's ArrayBuffer can be freed before the next file is made. Matters on 4 GB Chromebooks.
      this.parts.push(local, new Blob([bytes]));
      this.central.push(cen);
      this.offset += local.length + size;
      this.count++;
    }

    toBlob(type) {
      let cdSize = 0;
      for (const c of this.central) cdSize += c.length;
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, this.count, true);
      ev.setUint16(10, this.count, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, this.offset, true);
      return new Blob(this.parts.concat(this.central, [end]), { type: type || 'application/zip' });
    }
  }
  SS.ZipWriter = ZipWriter;

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') throw new SS.UserError('This browser cannot open compressed zip files.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Returns a Map of entry name -> Uint8Array (views into the input where possible). */
  SS.readZip = async function (input) {
    const u8 = toBytes(input);
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new SS.UserError('That file is not a zip file, or it is damaged.');
    const entries = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const files = new Map();
    const decoder = new TextDecoder();
    for (let n = 0; n < entries; n++) {
      if (p + 46 > u8.length || view.getUint32(p, true) !== 0x02014b50) throw new SS.UserError('That zip file is damaged.');
      const method = view.getUint16(p + 10, true);
      const csize = view.getUint32(p + 20, true);
      const nlen = view.getUint16(p + 28, true);
      const xlen = view.getUint16(p + 30, true);
      const clen = view.getUint16(p + 32, true);
      const lho = view.getUint32(p + 42, true);
      const name = decoder.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (lho + 30 > u8.length || view.getUint32(lho, true) !== 0x04034b50) throw new SS.UserError('That zip file is damaged.');
      const start = lho + 30 + view.getUint16(lho + 26, true) + view.getUint16(lho + 28, true);
      const data = u8.subarray(start, start + csize);
      if (data.length !== csize) throw new SS.UserError('That zip file is cut short.');
      if (method === 0) files.set(name, data);
      else if (method === 8) files.set(name, await inflateRaw(data));
      else throw new SS.UserError('That zip file uses a format this app cannot read.');
    }
    return files;
  };

  if (typeof module === 'object' && module.exports) module.exports = SS;
})(typeof window !== 'undefined' ? window : globalThis);
