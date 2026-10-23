// Makes test audio for trying the app: a drum beat (named with its BPM, like downloaded beats are),
// a bassline at a different sample rate, and a short tone. Output: test-audio/
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SS = require('../app/js/wav.js');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-audio');
mkdirSync(out, { recursive: true });

function beat(rate, bpm, bars) {
  const spb = 60 / bpm;
  const len = Math.round(bars * 4 * spb * rate);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t, dur, fn, pan) => {
    const s0 = Math.round(t * rate);
    for (let i = 0; i < dur * rate && s0 + i < len; i++) {
      const v = fn(i / rate);
      L[s0 + i] += v * (1 - Math.max(0, pan));
      R[s0 + i] += v * (1 + Math.min(0, pan));
    }
  };
  for (let b = 0; b < bars * 4; b++) {
    const t = b * spb;
    if (b % 2 === 0) add(t, 0.35, (x) => Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-x * 25)) * x) * Math.exp(-x * 9) * 0.8, 0);
    else add(t, 0.25, (x) => (noise() * 0.5 + Math.sin(2 * Math.PI * 190 * x) * 0.4) * Math.exp(-x * 18) * 0.6, 0);
    for (const h of [0, 0.5]) add(t + h * spb, 0.05, (x) => noise() * Math.exp(-x * 90) * 0.25, 0.4);
  }
  return [L, R];
}

function bass(rate, bpm, bars) {
  const spb = 60 / bpm;
  const len = Math.round(bars * 4 * spb * rate);
  const d = new Float32Array(len);
  const notes = [55, 55, 65.4, 49];
  for (let b = 0; b < bars * 4; b++) {
    const f = notes[Math.floor(b / 4) % notes.length];
    const s0 = Math.round(b * spb * rate);
    for (let i = 0; i < spb * rate * 0.9 && s0 + i < len; i++) {
      const x = i / rate;
      d[s0 + i] = Math.sin(2 * Math.PI * f * x) * 0.5 * Math.min(1, x * 200) * Math.exp(-x * 1.5);
    }
  }
  return [d];
}

function tone(rate, sec, freq) {
  const d = new Float32Array(Math.round(rate * sec));
  for (let i = 0; i < d.length; i++) d[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.3;
  return [d];
}

const files = [
  ['Test Beat 120 BPM.wav', beat(44100, 120, 8), 44100, 16],
  ['Test Bass.wav', bass(48000, 120, 8), 48000, 24],
  ['Test Tone 440.wav', tone(48000, 3, 440), 48000, 16],
];
for (const [name, chans, rate, bits] of files) {
  writeFileSync(join(out, name), Buffer.from(SS.encodeWav(chans, rate, bits)));
  console.log('wrote', name);
}
