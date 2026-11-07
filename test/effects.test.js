// Effects tests: node --test "test/*.test.js"
// Saved songs keep working (old songs gain no surprises), effect settings survive saving, the key finder
// is measured on synthetic chord progressions, and Auto-Tune's delay is measured at other sample rates.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../app/js/util.js');
require('../app/js/model.js');
require('../app/js/autotune.js');
const SS = require('../app/js/effects.js');
const M = SS.model;

test('a song saved before effects existed loads unchanged, with no effects and key "any"', () => {
  const old = {
    name: 'Old Song', sampleRate: 48000, bpm: 92, beatsPerBar: 4, showBeats: true,
    tracks: [{ id: 't1', name: 'Beat', color: '#4f7cff', gain: -3, pan: 0.2, mute: false, solo: false,
      clips: [{ id: 'c1', src: 's1', name: 'beat', offset: 0, start: 0, dur: 30 }] }],
  };
  const p = M.sanitizeProject(JSON.parse(JSON.stringify(old)));
  assert.equal(p.key, 'any');
  assert.deepEqual(p.tracks[0].fx, []);
  // Everything that was there before is exactly as it was.
  assert.equal(p.name, 'Old Song');
  assert.equal(p.bpm, 92);
  assert.equal(p.tracks[0].gain, -3);
  assert.equal(p.tracks[0].pan, 0.2);
  assert.deepEqual(p.tracks[0].clips, old.tracks[0].clips);
});

test('effect settings and the key survive saving and loading', () => {
  const p = M.newProject('S', 48000);
  p.key = 'F# minor';
  const t = M.createTrack(p, 'Vocal');
  t.fx.push(SS.newFx('reverb', { amount: 0.7, size: 0.2 }), SS.newFx('autotune', { style: 0.9 }));
  t.fx[0].on = false;
  p.tracks.push(t);
  const back = M.sanitizeProject(JSON.parse(JSON.stringify(p)));
  assert.equal(back.key, 'F# minor');
  const fx = back.tracks[0].fx;
  assert.deepEqual(fx.map((f) => f.type), ['autotune', 'reverb'], 'kept in listening order');
  assert.equal(fx[0].style, 0.9);
  assert.equal(fx[1].on, false);
  assert.equal(fx[1].amount, 0.7);
  assert.equal(fx[1].size, 0.2);
  assert.ok(JSON.parse(M.serializeState(p)).key === 'F# minor', 'undo/redo remembers the key');
});

test('junk effect data is cleaned, never trusted', () => {
  const fx = SS.sanitizeFx([
    null, 'x', { type: 'flanger' }, { type: 'echo', amount: 7, repeats: -2, timing: '1/3', on: 0 },
    { type: 'echo', amount: 0.1 }, { type: 'autotune', style: 'loud' }, { type: 'reverb', __proto__: { amount: 1 } },
  ]);
  assert.deepEqual(fx.map((f) => f.type), ['autotune', 'echo', 'reverb']);
  const echo = fx.find((f) => f.type === 'echo');
  assert.equal(echo.amount, 1);
  assert.equal(echo.repeats, 0);
  assert.equal(echo.timing, '1/4');
  assert.equal(echo.on, true, 'only an explicit false switches an effect off');
  assert.equal(fx.find((f) => f.type === 'autotune').style, 0.5);
  assert.equal(M.sanitizeProject({ key: 'H major' }).key, 'any');
  assert.deepEqual(SS.sanitizeFx(undefined), []);
});

test('fxShape lists the switched-on effects in listening order', () => {
  const list = [SS.newFx('reverb'), SS.newFx('autotune'), Object.assign(SS.newFx('echo'), { on: false })];
  assert.equal(SS.fxShape(list), 'autotune,reverb');
  assert.equal(SS.fxShape([]), '');
});

// ---- key finding ---------------------------------------------------------------------------
const FS = 44100;
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// A chord progression played on a soft synth (a few harmonics per note), plus a bass note.
function progression(chords, secondsEach) {
  const n = Math.round(chords.length * secondsEach * FS);
  const x = new Float32Array(n);
  chords.forEach((notes, ci) => {
    const s0 = Math.round(ci * secondsEach * FS);
    const len = Math.round(secondsEach * FS);
    const voices = notes.concat([notes[0] - 12]);
    for (const m of voices) {
      const f = midiHz(m);
      for (let h = 1; h <= 4; h++) {
        const a = 0.15 / h;
        for (let i = 0; i < len; i++) x[s0 + i] += a * Math.sin((2 * Math.PI * f * h * i) / FS) * Math.min(1, i / 400, (len - i) / 400);
      }
    }
  });
  return x;
}

// Triads from scale degrees of a major key starting at `tonic` (MIDI).
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
function triad(tonic, degree, minorKey) {
  const steps = minorKey ? [0, 2, 3, 5, 7, 8, 10] : MAJOR_STEPS;
  const at = (d) => tonic + steps[d % 7] + 12 * Math.floor(d / 7);
  return [at(degree), at(degree + 2), at(degree + 4)];
}

test('the key finder picks the right notes for common chord progressions (measured)', () => {
  const NAMES = M.NOTE_NAMES;
  const cases = [];
  // Pop I-V-vi-IV and i-VI-III-VII (a very common minor loop), in several keys.
  for (const root of [60, 62, 64, 65, 67, 69, 57, 59]) {
    cases.push({ want: NAMES[root % 12] + ' major', chords: [0, 4, 5, 3].map((d) => triad(root, d, false)) });
    cases.push({ want: NAMES[root % 12] + ' minor', chords: [0, 5, 2, 6].map((d) => triad(root, d, true)) });
  }
  let exact = 0;
  let sameNotes = 0;
  const misses = [];
  const margins = [];
  for (const c of cases) {
    const audio = progression(c.chords.concat(c.chords), 1.2);
    const chroma = new Float64Array(12);
    SS.addChroma([audio], FS, 0, audio.length, chroma);
    const got = SS.keyFromChroma(chroma);
    margins.push(got.margin);
    if (got.key === c.want) exact++;
    // For Auto-Tune only the allowed notes matter: C major and A minor use the very same notes.
    if (SS.AutoTune.keyMask(got.key) === SS.AutoTune.keyMask(c.want)) sameNotes++;
    else misses.push(c.want + ' -> ' + got.key);
  }
  // Something with no key at all (noise and a drum-like thump) should come out as unsure.
  let s = 3;
  const noise = new Float32Array(FS * 8).map((_, i) => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3 +
    0.5 * Math.sin(2 * Math.PI * 55 * (i % 22050) / FS) * Math.exp(-(i % 22050) / 2000));
  const nc = new Float64Array(12);
  SS.addChroma([noise], FS, 0, noise.length, nc);
  const unsure = SS.keyFromChroma(nc);
  console.log(`\nKey finder on ${cases.length} progressions: exact key ${exact}/${cases.length}, right notes ${sameNotes}/${cases.length}` +
    (misses.length ? '; wrong notes: ' + misses.join(', ') : '') +
    `\n  margin over the best key with other notes: min ${Math.min(...margins).toFixed(3)}, median ${margins.sort((a, b) => a - b)[margins.length >> 1].toFixed(3)}` +
    `\n  noise + kick: ${unsure.key}, margin ${unsure.margin.toFixed(3)}, r ${unsure.r.toFixed(3)}`);
  assert.ok(sameNotes >= cases.length - 1, `right notes in ${sameNotes} of ${cases.length}`);
  assert.ok(unsure.margin < Math.min(...margins), 'a keyless sound is less sure than any real progression');
});

// ---- Vocal Polish's compressor ----------------------------------------------------------------
test('the compressor follows its settings: no change below the threshold, the set ratio above it', () => {
  const c = new SS.Compressor(48000);
  c.set({ threshold: -20, ratio: 4, knee: 8, makeup: 0 });
  assert.equal(c.curve(-40), 0, 'quiet sound untouched');
  assert.ok(Math.abs(c.curve(0) - (1 / 4 - 1) * 20) < 1e-9, '20 dB over at 4:1 comes out 5 dB over');
  // The soft knee (8 dB wide, centred on the threshold) joins the two smoothly: it starts at 0 at -24 dB,
  // meets the 4:1 line at -16 dB, and never jumps or turns back on the way.
  assert.equal(c.curve(-24), 0);
  assert.ok(Math.abs(c.curve(-16) - (1 / 4 - 1) * 4) < 1e-9);
  let prev = 0;
  for (let x = -30; x <= 0; x += 0.05) {
    const g = c.curve(x);
    assert.ok(g <= prev + 1e-12 && prev - g < 0.05, `smooth and never rising at ${x.toFixed(2)} dB`);
    prev = g;
  }
});

test('the compressor settles at the right gain, at its attack and release speed (measured)', () => {
  const FS = 48000;
  const c = new SS.Compressor(FS);
  c.set({ threshold: -20, ratio: 4, knee: 0.001, attack: 0.005, release: 0.12, makeup: 3 });
  // A 1 kHz tone at -6 dBFS for 0.5 s, then at -40 dBFS for 0.5 s.
  const n = FS;
  const inp = new Float32Array(n).map((_, i) => (i < n / 2 ? 0.5 : 0.01) * Math.sin((2 * Math.PI * 1000 * i) / FS));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 128) c.process([inp.subarray(i, i + 128)], [out.subarray(i, i + 128)]);
  const peakDb = (x, a, b) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i])); return 20 * Math.log10(m); };
  const loud = peakDb(out, 0.4 * FS, 0.5 * FS) - peakDb(inp, 0.4 * FS, 0.5 * FS);
  const quiet = peakDb(out, 0.95 * FS, FS) - peakDb(inp, 0.95 * FS, FS);
  // Ideal: 14 dB over at 4:1 -> -10.5 dB, plus 3 dB makeup = -7.5 dB; quiet part: just the makeup, once released.
  // The detector follows each sample (no peak hold), so between a waveform's peaks it lets go a little:
  // a steady tone ends up up to about 1 dB short of the ideal reduction.
  console.log(`  compressor: loud part ${loud.toFixed(2)} dB (ideal -7.50), quiet part ${quiet.toFixed(2)} dB (ideal +3.00)`);
  assert.ok(loud < -6.5 && loud > -7.6, `loud part ${loud.toFixed(2)} dB`);
  assert.ok(Math.abs(quiet - 3) < 0.3, `quiet part ${quiet.toFixed(2)} dB`);
});

test('the audio-thread code (Auto-Tune + compressor) is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(SS.FX_WORKLET));
  assert.match(SS.FX_WORKLET, /registerProcessor\('ss-autotune'/);
  assert.match(SS.FX_WORKLET, /registerProcessor\('ss-compressor'/);
});

// ---- Auto-Tune delay at other sample rates --------------------------------------------------
test('Auto-Tune delay matches what the app compensates for at 44.1, 48 and 96 kHz', () => {
  for (const rate of [44100, 48000, 96000]) {
    for (const live of [false, true]) {
      const rt = new SS.AutoTune.Retuner(rate);
      rt.set_refpitch(440);
      rt.set_notebias(0.5);
      rt.set_notemask(0xfff);
      rt.set_corrfilt(0.1);
      rt.set_corrgain(1);
      rt.set_fastmode(live);
      const inp = new Float32Array(rate);
      // A burst of a 220 Hz buzz after a quarter second of silence.
      for (let i = rate / 4; i < rate / 2; i++) inp[i] = 0.4 * ((((i * 220) / rate) % 1) - 0.5);
      const out = new Float32Array(inp.length);
      for (let i = 0; i < inp.length; i += 128) rt.process(Math.min(128, inp.length - i), inp, i, out, i);
      const onset = (x) => x.findIndex((v) => Math.abs(v) > 0.05);
      const measured = onset(out) - onset(inp);
      const compensated = Math.round(SS.autotuneLatency(rate, live) * rate);
      console.log(`  ${rate} Hz ${live ? 'live  ' : 'normal'}: measured ${measured} samples, compensated ${compensated}`);
      assert.ok(Math.abs(measured - compensated) <= rate / 1000, `${rate} ${live}: measured ${measured}, compensated ${compensated}`);
    }
  }
});
