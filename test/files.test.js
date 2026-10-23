// WAV and ZIP tests: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
require('../app/js/util.js');
require('../app/js/wav.js');
const SS = require('../app/js/zip.js');

function sine(len, f, rate, amp) {
  const d = new Float32Array(len);
  for (let i = 0; i < len; i++) d[i] = Math.sin((2 * Math.PI * f * i) / rate) * amp;
  return d;
}

for (const bits of [16, 24, 32]) {
  test(`WAV ${bits}-bit round trip keeps length, rate and samples`, () => {
    const L = sine(1001, 440, 48000, 0.8);
    const R = sine(1001, 660, 48000, 0.5);
    R[10] = 1.5; // over full scale: must clip, not wrap around
    const buf = SS.encodeWav([L, R], 48000, bits);
    const back = SS.decodeWav(buf);
    assert.equal(back.sampleRate, 48000);
    assert.equal(back.length, 1001);
    assert.equal(back.channels.length, 2);
    // 16-bit adds +-1 step of dither on top of rounding, so allow 3 steps (-90 dB, inaudible).
    const tol = bits === 16 ? 3 / 32768 : bits === 24 ? 1 / 4e6 : 1e-7;
    for (let i = 0; i < 1001; i++) {
      if (i === 10) continue;
      assert.ok(Math.abs(back.channels[0][i] - L[i]) < tol, `L[${i}]`);
      assert.ok(Math.abs(back.channels[1][i] - R[i]) < tol, `R[${i}]`);
    }
    if (bits !== 32) assert.ok(back.channels[1][10] > 0.99, 'clipped to the top, not wrapped');
  });
}

test('WAV header sizes are right (other apps check them)', () => {
  const buf = SS.encodeWav([new Float32Array(100)], 44100, 24);
  const v = new DataView(buf);
  assert.equal(buf.byteLength, 44 + 300);
  assert.equal(v.getUint32(4, true), buf.byteLength - 8);
  assert.equal(v.getUint32(40, true), 300);
  assert.equal(v.getUint16(32, true), 3, 'block align');
  assert.equal(v.getUint32(28, true), 44100 * 3, 'byte rate');
});

test('16-bit export keeps digital silence perfectly silent', () => {
  const back = SS.decodeWav(SS.encodeWav([new Float32Array(500)], 48000, 16));
  assert.ok(back.channels[0].every((x) => x === 0));
});

test('CRC32 matches the standard check value', () => {
  assert.equal(SS.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('ZIP round trip', async () => {
  const z = new SS.ZipWriter();
  const a = new Uint8Array([1, 2, 3, 4, 5]);
  const b = new TextEncoder().encode('Song stems/02 Vocals — take 2.wav');
  z.add('Song stems/01 Beat.wav', a);
  z.add('notes.txt', b);
  assert.throws(() => z.add('notes.txt', b), /Duplicate/);
  const bytes = new Uint8Array(await z.toBlob().arrayBuffer());
  const files = await SS.readZip(bytes);
  assert.deepEqual([...files.keys()], ['Song stems/01 Beat.wav', 'notes.txt']);
  assert.deepEqual([...files.get('Song stems/01 Beat.wav')], [...a]);
  assert.equal(new TextDecoder().decode(files.get('notes.txt')), 'Song stems/02 Vocals — take 2.wav');
});

test('ZIP reader rejects junk politely', async () => {
  await assert.rejects(SS.readZip(new Uint8Array(100)), (e) => e.name === 'UserError');
});
