/* Audabook — WAV encode/decode. Used for exported stems and for audio inside project files. */
(function (root) {
  'use strict';
  const SS = (root.SS = root.SS || {});
  const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  function ascii(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  /**
   * channels: Float32Array per channel, all the same length.
   * bitDepth: 16 or 24 (integer PCM) or 32 (float). Returns an ArrayBuffer holding the whole file.
   */
  SS.encodeWav = function (channels, sampleRate, bitDepth) {
    bitDepth = bitDepth || 16;
    if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) throw new Error('Unsupported bit depth ' + bitDepth);
    const numCh = channels.length;
    const length = numCh ? channels[0].length : 0;
    const isFloat = bitDepth === 32;
    const blockAlign = numCh * (bitDepth / 8);
    const dataSize = length * blockAlign;
    // A 16-byte fmt chunk keeps the sample data 4-byte aligned (44 or 56 bytes of header).
    const headerSize = isFloat ? 56 : 44;
    if (headerSize + dataSize > 0xffffffff) {
      throw new SS.UserError('This audio is too long to save as one WAV file (over 4 GB).');
    }
    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);
    ascii(view, 0, 'RIFF');
    view.setUint32(4, headerSize + dataSize - 8, true);
    ascii(view, 8, 'WAVE');
    ascii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, isFloat ? 3 : 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    let p = 36;
    if (isFloat) {
      ascii(view, p, 'fact');
      view.setUint32(p + 4, 4, true);
      view.setUint32(p + 8, length, true);
      p += 12;
    }
    ascii(view, p, 'data');
    view.setUint32(p + 4, dataSize, true);
    p += 8;

    if (isFloat && LITTLE_ENDIAN) {
      const out = new Float32Array(buffer, p, length * numCh);
      if (numCh === 1) out.set(channels[0]);
      else for (let i = 0, o = 0; i < length; i++) for (let c = 0; c < numCh; c++) out[o++] = channels[c][i];
    } else if (bitDepth === 16 && LITTLE_ENDIAN) {
      const out = new Int16Array(buffer, p, length * numCh);
      let o = 0;
      for (let i = 0; i < length; i++) {
        for (let c = 0; c < numCh; c++) {
          const s = channels[c][i];
          if (s === 0) {
            out[o++] = 0; // keep digital silence truly silent
            continue;
          }
          // TPDF dither hides the distortion of rounding to 16 bits.
          const v = Math.round(s * 32767 + (Math.random() - Math.random()));
          out[o++] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
      }
    } else if (bitDepth === 24) {
      const out = new Uint8Array(buffer, p, dataSize);
      let o = 0;
      for (let i = 0; i < length; i++) {
        for (let c = 0; c < numCh; c++) {
          const s = channels[c][i];
          let v = Math.round(s < 0 ? s * 8388608 : s * 8388607);
          if (v > 8388607) v = 8388607;
          else if (v < -8388608) v = -8388608;
          else if (v !== v) v = 0;
          out[o++] = v & 255;
          out[o++] = (v >> 8) & 255;
          out[o++] = (v >> 16) & 255;
        }
      }
    } else {
      // Big-endian machines (none of today's Chromebooks) take the slow, portable path.
      for (let i = 0; i < length; i++) {
        for (let c = 0; c < numCh; c++) {
          const s = channels[c][i];
          if (isFloat) view.setFloat32(p, s, true);
          else view.setInt16(p, SS.clamp(Math.round(s * 32767), -32768, 32767) || 0, true);
          p += bitDepth / 8;
        }
      }
    }
    return buffer;
  };

  // "format:bits" -> sample reader returning -1..1
  const SAMPLE_READERS = {
    '3:32': (view, u8, o) => view.getFloat32(o, true),
    '3:64': (view, u8, o) => view.getFloat64(o, true),
    '1:16': (view, u8, o) => view.getInt16(o, true) / 32768,
    '1:24': (view, u8, o) => (((u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) << 8) >> 8) / 8388608,
    '1:32': (view, u8, o) => view.getInt32(o, true) / 2147483648,
    '1:8': (view, u8, o) => (u8[o] - 128) / 128,
  };

  /**
   * Reads PCM (8/16/24/32-bit) or float (32/64-bit) WAV data.
   * alloc(numChannels, frames, sampleRate) may return the Float32Arrays to fill (e.g. an AudioBuffer's),
   * so a large file is not copied twice.
   */
  SS.decodeWav = function (input, alloc) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (u8.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new SS.UserError('That is not a WAV file.');
    let fmt = null;
    let dataOff = -1;
    let dataLen = 0;
    let p = 12;
    while (p + 8 <= u8.length) {
      const id = tag(p);
      const size = view.getUint32(p + 4, true);
      const body = p + 8;
      if (id === 'fmt ') {
        let format = view.getUint16(body, true);
        if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
        fmt = {
          format,
          channels: view.getUint16(body + 2, true),
          rate: view.getUint32(body + 4, true),
          bits: view.getUint16(body + 14, true),
        };
      } else if (id === 'data') {
        dataOff = body;
        dataLen = Math.min(size, u8.length - body);
        break;
      }
      p = body + size + (size & 1);
    }
    if (!fmt || dataOff < 0 || !fmt.channels) throw new SS.UserError('That WAV file is damaged or empty.');
    const numCh = fmt.channels;
    const bytes = fmt.bits / 8;
    const frames = Math.floor(dataLen / (bytes * numCh));
    const out = alloc
      ? alloc(numCh, frames, fmt.rate)
      : Array.from({ length: numCh }, () => new Float32Array(frames));
    const kind = fmt.format + ':' + fmt.bits;
    const read = SAMPLE_READERS[kind];
    if (!read) throw new SS.UserError('That WAV format (' + kind + ') is not supported.');
    let o = dataOff;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        out[c][i] = read(view, u8, o);
        o += bytes;
      }
    }
    return { sampleRate: fmt.rate, channels: out, length: frames };
  };

  if (typeof module === 'object' && module.exports) module.exports = SS;
})(typeof window !== 'undefined' ? window : globalThis);
