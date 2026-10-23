/* Audabook — shared helpers. Every other script hangs off the SS namespace.
   Scripts are plain (non-module) files so the app also runs when opened as a local file. */
(function (root) {
  'use strict';
  const SS = (root.SS = root.SS || {});

  SS.VERSION = '1.0.0';
  SS.APP_NAME = 'Audabook';

  let counter = 0;
  SS.uid = function (prefix) {
    counter = (counter + 1) % 1679616;
    return (prefix || 'id') + Date.now().toString(36) + counter.toString(36) + Math.random().toString(36).slice(2, 6);
  };

  SS.clamp = function (v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  };

  SS.finite = function (v, fallback) {
    v = Number(v);
    return isFinite(v) ? v : fallback;
  };

  // Track volume is stored in dB; the bottom of the slider means silence.
  SS.MIN_DB = -60;
  SS.MAX_DB = 6;
  SS.dbToGain = function (db) {
    return db <= SS.MIN_DB ? 0 : Math.pow(10, db / 20);
  };

  // 83.456 -> "1:23.456". decimals = 0 gives "1:23".
  SS.formatTime = function (sec, decimals) {
    if (decimals == null) decimals = 3;
    if (!isFinite(sec)) sec = 0;
    const neg = sec < 0;
    sec = Math.abs(sec);
    const scale = Math.pow(10, decimals);
    let total = Math.round(sec * scale);
    const frac = total % scale;
    total = (total - frac) / scale;
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    let out = (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
    if (decimals > 0) out += '.' + String(frac).padStart(decimals, '0');
    return (neg ? '-' : '') + out;
  };

  SS.formatDb = function (db) {
    if (db <= SS.MIN_DB) return '-∞ dB';
    const r = Math.round(db * 10) / 10;
    return (r > 0 ? '+' : '') + (r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)) + ' dB';
  };

  SS.formatPan = function (p) {
    if (Math.abs(p) < 0.01) return 'C';
    return (p < 0 ? 'L' : 'R') + Math.round(Math.abs(p) * 100);
  };

  // Something safe to use as a file or folder name on ChromeOS, Windows and macOS.
  SS.safeFileName = function (name) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 80);
    return cleaned || 'Untitled';
  };

  SS.plural = function (n, word, many) {
    return n + ' ' + (n === 1 ? word : many || word + 's');
  };

  // An error whose message is written for the person using the app, not a developer.
  class UserError extends Error {
    constructor(message) {
      super(message);
      this.name = 'UserError';
    }
  }
  SS.UserError = UserError;

  if (typeof module === 'object' && module.exports) module.exports = SS;
})(typeof window !== 'undefined' ? window : globalThis);
