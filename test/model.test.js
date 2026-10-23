// Editing model tests: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
require('../app/js/util.js');
const SS = require('../app/js/model.js');
const M = SS.model;

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} expected ${b}, got ${a}`);

function track(clips) {
  return { id: 't', name: 'T', color: '#000000', gain: 0, pan: 0, mute: false, solo: false, clips };
}
const clip = (id, start, dur, offset = 0, src = 's1') => ({ id, src, name: '', offset, start, dur });

test('carve cuts the middle out of a clip and keeps both sides in sync with the audio', () => {
  const t = track([clip('a', 0, 10)]);
  M.carve(t, 3, 5);
  assert.equal(t.clips.length, 2);
  close(t.clips[0].start, 0);
  close(t.clips[0].dur, 3);
  close(t.clips[1].start, 5);
  close(t.clips[1].offset, 5, 'right piece plays the audio from 5 s');
  close(t.clips[1].dur, 5);
  assert.notEqual(t.clips[0].id, t.clips[1].id);
});

test('carve trims overlapping edges and removes clips fully inside', () => {
  const t = track([clip('a', 0, 4), clip('b', 4.5, 1), clip('c', 6, 4, 2)]);
  M.carve(t, 3, 7);
  assert.deepEqual(t.clips.map((c) => c.id), ['a', 'c']);
  close(t.clips[0].dur, 3);
  close(t.clips[1].start, 7);
  close(t.clips[1].offset, 3, 'offset moves with the trimmed start');
  close(t.clips[1].dur, 3);
});

test('delete with ripple closes the gap; without ripple leaves silence', () => {
  const p = M.newProject('x');
  p.tracks.push(track([clip('a', 0, 10)]));
  M.deleteRange(p, new Set(['t']), 2, 4, false);
  close(M.projectEnd(p), 10);
  M.deleteRange(p, new Set(['t']), 2, 4, true);
  close(M.projectEnd(p), 8);
  close(p.tracks[0].clips[1].start, 2);
  close(p.tracks[0].clips[1].offset, 4);
});

test('split creates two clips that play seamlessly', () => {
  const t = track([clip('a', 1, 4, 0.5)]);
  assert.equal(M.splitTrackAt(t, 3), true);
  const [l, r] = t.clips;
  close(l.start + l.dur, r.start);
  close(l.offset + l.dur, r.offset);
  assert.equal(M.splitTrackAt(t, 0.5), false, 'nothing to split outside clips');
});

test('copy and paste replaces what is under the paste', () => {
  const p = M.newProject('x');
  p.tracks.push(track([clip('a', 0, 4, 0, 'A'), clip('b', 6, 4, 0, 'B')]));
  const cb = M.copyRange(p, new Set(['t']), 1, 3);
  close(cb.dur, 2);
  close(cb.tracks[0].clips[0].start, 0);
  close(cb.tracks[0].clips[0].offset, 1);
  M.paste(p, ['t'], 7, cb);
  const clips = p.tracks[0].clips;
  assert.deepEqual(clips.map((c) => c.src), ['A', 'B', 'A', 'B']);
  close(clips[2].start, 7);
  close(clips[3].start, 9);
  close(clips[3].offset, 3);
});

test('paste onto more tracks than are selected makes new tracks', () => {
  const p = M.newProject('x');
  p.tracks.push(track([clip('a', 0, 4)]));
  const cb = { dur: 1, tracks: [{ name: 'One', clips: [] }, { name: 'Two', clips: [{ src: 's', name: '', offset: 0, start: 0, dur: 1 }] }] };
  const used = M.paste(p, ['t'], 0, cb);
  assert.equal(used.length, 2);
  assert.equal(p.tracks.length, 2);
  assert.equal(p.tracks[1].name, 'Two');
});

test('trim to range keeps only the selection', () => {
  const p = M.newProject('x');
  p.tracks.push(track([clip('a', 0, 10)]));
  M.trimToRange(p, new Set(['t']), 2, 5);
  assert.equal(p.tracks[0].clips.length, 1);
  close(p.tracks[0].clips[0].start, 2);
  close(p.tracks[0].clips[0].dur, 3);
});

test('dragged clip edges stop at neighbours and at the ends of the audio', () => {
  const t = track([clip('a', 0, 2), clip('b', 3, 2, 1), clip('c', 7, 1)]);
  const b = t.clips[1];
  const bounds = M.trimBounds(t, b, 4); // source is 4 s long; b plays 1..3 of it
  close(bounds.minStart, 2, 'stops at the end of clip a');
  close(bounds.maxEnd, 6, 'source runs out at 2 + 4');
  M.setClipLeft(b, 0, bounds, 0.01);
  close(b.start, 2);
  close(b.offset, 0);
  M.setClipRight(b, 99, bounds, 0.01);
  close(b.start + b.dur, 6);
});

test('settling a moved clip clears what it lands on', () => {
  const t = track([clip('a', 0, 4), clip('m', 2, 1, 0, 'M')]);
  M.settleClip(t, t.clips[1]);
  assert.equal(t.clips.length, 3);
  assert.deepEqual(t.clips.map((c) => c.src), ['s1', 'M', 's1']);
  close(t.clips[0].dur, 2);
  close(t.clips[2].start, 3);
  close(t.clips[2].offset, 3, 'the rest of clip a still plays its own audio');
  const ends = t.clips.map((c) => [c.start, c.start + c.dur]);
  for (let i = 1; i < ends.length; i++) assert.ok(ends[i][0] >= ends[i - 1][1] - 1e-9, 'no overlaps');
});

test('every stem gets the same number of samples', () => {
  assert.equal(M.stemFrames(3.5, 48000), 168000);
  assert.equal(M.stemFrames(1 / 3, 44100), 14700);
  assert.equal(M.stemFrames(0, 44100), 1);
});

test('next track names count up', () => {
  const p = M.newProject('x');
  p.tracks.push({ name: 'Take 1' }, { name: 'Take 3' }, { name: 'Vocals' });
  assert.equal(M.nextTrackName(p, 'Take'), 'Take 4');
  assert.equal(M.nextTrackName(p, 'Track'), 'Track 1');
});

test('BPM is read from beat file names', () => {
  assert.equal(M.parseBpm('Dark Trap Beat 140 BPM.mp3'), 140);
  assert.equal(M.parseBpm('lofi_92bpm_Cmin.wav'), 92);
  assert.equal(M.parseBpm('BPM 128 - house.wav'), 128);
  assert.equal(M.parseBpm('My Song.mp3'), null);
  assert.equal(M.parseBpm('track 2024 final.wav'), null);
  assert.equal(M.parseBpm('weird 999 bpm.wav'), null);
});

test('sanitize drops junk and fixes overlaps from untrusted project data', () => {
  const p = M.sanitizeProject({
    name: '  Song  ', bpm: 'fast', beatsPerBar: 99,
    tracks: [
      { id: 't1', name: '', color: 'red', gain: 50, pan: -7, clips: [clip('a', 0, 4), clip('b', 2, 4), { src: 5 }, clip('z', 1, -1)] },
      null,
    ],
  });
  assert.equal(p.name, 'Song');
  assert.equal(p.bpm, 120);
  assert.equal(p.beatsPerBar, 12);
  assert.equal(p.tracks.length, 1);
  const t = p.tracks[0];
  assert.equal(t.name, 'Track');
  assert.match(t.color, /^#[0-9a-f]{6}$/i);
  assert.equal(t.gain, SS.MAX_DB);
  assert.equal(t.pan, -1);
  for (let i = 1; i < t.clips.length; i++) assert.ok(t.clips[i].start >= t.clips[i - 1].start + t.clips[i - 1].dur - 1e-9);
});

test('undo history walks back and forth with labels', () => {
  const h = new SS.History(3);
  h.push({ label: 'A', state: '1' });
  h.push({ label: 'B', state: '2' });
  assert.equal(h.undoLabel(), 'B');
  const e = h.undo('3');
  assert.equal(e.state, '2');
  assert.equal(h.redoLabel(), 'B');
  const r = h.redo('2');
  assert.equal(r.state, '3');
  h.push({ label: 'C', state: '3' });
  h.push({ label: 'D', state: '4' });
  assert.equal(h.undoStack.length, 3, 'old steps fall off the end');
  assert.equal(h.canRedo(), false);
});
