// Auto-Tune measurements: node --test "test/*.test.js"
// A synthetic sung vowel at a known (off-key) pitch goes through the engine; the output pitch is measured
// with an independent detector (YIN, a different algorithm from the engine's) and compared to the target note.
const test = require('node:test');
const assert = require('node:assert/strict');
const SS = require('../app/js/autotune.js');
const { Retuner, keyMask, styleParams } = SS.AutoTune;

const FS = 48000;
const cents = (f, ref) => 1200 * Math.log2(f / ref);

// "Ah" sung at f0(t): a glottal pulse train shaped by three vowel formants, plus a little breath noise.
function voice(seconds, f0At, seed) {
  const n = Math.round(seconds * FS);
  const x = new Float32Array(n);
  let phase = 0;
  let s = seed || 1;
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    phase += f0At(i / FS) / FS;
    const p = phase - Math.floor(phase);
    src[i] = (p < 0.6 ? Math.sin((Math.PI * p) / 0.6) ** 2 : 0) - 0.3 + noise() * 0.01;
  }
  for (const [f, bw, g] of [[700, 110, 1], [1220, 120, 0.5], [2600, 160, 0.25]]) {
    const r = Math.exp((-Math.PI * bw) / FS);
    const a1 = -2 * r * Math.cos((2 * Math.PI * f) / FS);
    const a2 = r * r;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = src[i] - a1 * y1 - a2 * y2;
      y2 = y1;
      y1 = y;
      x[i] += y * g * (1 - r);
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = 0; i < n; i++) x[i] *= 0.5 / peak;
  return x;
}

// YIN pitch per frame (Hz, or 0 if unvoiced).
function yin(x, frame = 2048, hop = 480) {
  const out = [];
  const W = frame / 2;
  const d = new Float64Array(W);
  for (let start = 0; start + frame <= x.length; start += hop) {
    for (let tau = 1; tau < W; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const v = x[start + i] - x[start + i + tau];
        s += v * v;
      }
      d[tau] = s;
    }
    let run = 0;
    let best = -1;
    for (let tau = 1; tau < W; tau++) {
      run += d[tau];
      d[tau] = (d[tau] * tau) / (run || 1);
    }
    for (let tau = 40; tau < W - 1; tau++) {
      if (d[tau] < 0.15 && d[tau] <= d[tau + 1]) {
        best = tau;
        break;
      }
    }
    if (best < 0) {
      out.push(0);
      continue;
    }
    const a = d[best - 1];
    const b = d[best];
    const c = d[best + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    out.push(FS / (best + shift));
  }
  return out;
}

function run(input, key, style, fast) {
  const rt = new Retuner(FS);
  rt.set_refpitch(440);
  rt.set_notebias(0.5);
  rt.set_notemask(keyMask(key));
  const p = styleParams(style);
  rt.set_corrfilt(p.filter);
  rt.set_corrgain(p.corr);
  rt.set_fastmode(!!fast);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 128) rt.process(Math.min(128, input.length - i), input, i, out, i);
  return { out, latency: rt.latency() };
}

// Pitch error (cents) of every voiced frame after `skip` seconds, against the target frequency.
function errors(signal, target, skip) {
  const f = yin(signal.subarray(Math.round(skip * FS)));
  return f.filter((v) => v > 0).map((v) => cents(v, target));
}

const stats = (e) => {
  const a = e.map(Math.abs).sort((p, q) => p - q);
  return { frames: a.length, median: a[Math.floor(a.length / 2)], p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1] };
};

const report = [];
test.after(() => console.log('\nAuto-Tune measurements (cents from the target note):\n' + report.join('\n')));

test('steady +35 cents sharp is pulled onto the note (any key)', () => {
  const target = 220; // A3
  const inp = voice(2, () => target * 2 ** (35 / 1200));
  const before = stats(errors(inp, target, 0.4));
  const after = stats(errors(run(inp, 'any', 0.5).out, target, 0.4));
  report.push(`  +35c steady, any key:     input median ${before.median.toFixed(1)}  ->  output median ${after.median.toFixed(1)}, p95 ${after.p95.toFixed(1)}, max ${after.max.toFixed(1)} (${after.frames} frames)`);
  assert.ok(before.median > 30, 'test input really is off-key');
  assert.ok(after.median < 3, `output median ${after.median.toFixed(2)} cents`);
  assert.ok(after.p95 < 6, `output p95 ${after.p95.toFixed(2)} cents`);
});

test('a note outside the key goes to the nearest note in the key', () => {
  // 40 cents flat of D4 in C major: D4 is the nearest allowed note.
  const target = 293.665;
  const inp = voice(2, () => target * 2 ** (-40 / 1200));
  const after = stats(errors(run(inp, 'C major', 0.5).out, target, 0.4));
  report.push(`  D4 -40c, C major:          output median ${after.median.toFixed(1)}, p95 ${after.p95.toFixed(1)}`);
  assert.ok(after.median < 3, `median ${after.median.toFixed(2)}`);
  // And C#4 (not in C major) -10 cents goes to C4, the nearer of C and D.
  const inp2 = voice(2, () => 277.183 * 2 ** (-10 / 1200));
  const toC = stats(errors(run(inp2, 'C major', 0.5).out, 261.626, 0.4));
  report.push(`  C#4 -10c, C major -> C4:   output median ${toC.median.toFixed(1)}, p95 ${toC.p95.toFixed(1)}`);
  assert.ok(toC.median < 4, `median ${toC.median.toFixed(2)}`);
});

test('robot style flattens vibrato and drift onto the note', () => {
  const target = 196; // G3
  const f0 = (t) => target * 2 ** ((20 + 25 * Math.sin(2 * Math.PI * 5 * t)) / 1200);
  const inp = voice(3, f0, 7);
  const before = stats(errors(inp, target, 0.4));
  const robot = stats(errors(run(inp, 'any', 1).out, target, 0.4));
  const natural = stats(errors(run(inp, 'any', 0).out, target, 0.4));
  report.push(`  G3 +20c, vibrato +-25c:    input p95 ${before.p95.toFixed(1)}  ->  robot p95 ${robot.p95.toFixed(1)}, natural p95 ${natural.p95.toFixed(1)}`);
  assert.ok(robot.p95 < before.p95 / 3, `robot p95 ${robot.p95.toFixed(2)} vs input ${before.p95.toFixed(2)}`);
  assert.ok(natural.p95 > robot.p95, 'natural keeps more of the singer\'s movement than robot');
});

test('fast (live) mode also tunes, with lower latency', () => {
  const target = 220;
  const inp = voice(2, () => target * 2 ** (30 / 1200));
  const normal = run(inp, 'any', 0.5, false);
  const fast = run(inp, 'any', 0.5, true);
  const s = stats(errors(fast.out, target, 0.4));
  report.push(`  live (fast) mode +30c:     output median ${s.median.toFixed(1)}, p95 ${s.p95.toFixed(1)}; latency ${fast.latency} vs ${normal.latency} samples`);
  assert.ok(s.median < 4, `median ${s.median.toFixed(2)}`);
  assert.ok(fast.latency < normal.latency / 4);
});

test('reported latency matches the measured delay', () => {
  // A burst of voice after silence: find where the output burst starts versus the input's.
  const inp = new Float32Array(FS);
  inp.set(voice(0.5, () => 220).subarray(0, FS / 2), FS / 4);
  for (const fast of [false, true]) {
    const r = run(inp, 'any', 0.5, fast);
    const onset = (x) => x.findIndex((v) => Math.abs(v) > 0.05);
    const measured = onset(r.out) - onset(inp);
    report.push(`  latency (${fast ? 'live' : 'normal'}):          reported ${r.latency}, measured ${measured} samples`);
    assert.ok(Math.abs(measured - r.latency) < 40, `reported ${r.latency}, measured ${measured}`);
  }
});

test('silence stays silent, and nothing ever goes NaN', () => {
  const r = run(new Float32Array(FS), 'any', 1);
  assert.ok(r.out.every((v) => v === 0 || Math.abs(v) < 1e-6));
  let s = 7;
  const noise = new Float32Array(FS).map(() => ((s = (s * 16807) % 2147483647) / 2147483647) * 0.6 - 0.3);
  const rn = run(noise, 'C major', 1);
  assert.ok(rn.out.every((v) => Number.isFinite(v)));
});

test('fast enough for a low-end Chromebook', () => {
  const inp = voice(10, () => 220 * 2 ** (20 / 1200));
  const t0 = process.hrtime.bigint();
  run(inp, 'any', 0.5);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  report.push(`  CPU: ${ms.toFixed(0)} ms to tune 10 s of audio here (${((ms / 10000) * 100).toFixed(1)}% of one core)`);
  assert.ok(ms < 1500);
});

test('key names map to the right notes', () => {
  const bits = (m) => [...Array(12).keys()].filter((i) => m & (1 << i));
  assert.deepEqual(bits(keyMask('C major')), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(bits(keyMask('A minor')), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(bits(keyMask('E minor')), [0, 2, 4, 6, 7, 9, 11]);
  assert.deepEqual(bits(keyMask('F# major')), [1, 3, 5, 6, 8, 10, 11]);
  assert.equal(keyMask('any'), 0xfff);
});
