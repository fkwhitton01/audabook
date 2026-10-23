/* Audabook — .audabook project files: a zip holding project.json plus each piece of audio as a float WAV. */
(function (root) {
  'use strict';
  const SS = root.SS;
  const M = SS.model;
  const FORMAT = 'audabook-project';

  SS.PROJECT_EXT = '.audabook';

  /** onProgress(fraction) is called as each piece of audio is packed. */
  SS.buildProjectFile = async function (project, sources, onProgress) {
    const zip = new SS.ZipWriter();
    const list = [];
    for (const id of M.referencedSources(project)) {
      const src = sources.get(id);
      if (src) list.push({ id, name: src.name, file: 'audio/' + id + '.wav', src });
    }
    const meta = {
      format: FORMAT,
      version: 1,
      app: SS.APP_NAME + ' ' + SS.VERSION,
      savedAt: new Date().toISOString(),
      project: {
        name: project.name,
        sampleRate: project.sampleRate,
        bpm: project.bpm,
        beatsPerBar: project.beatsPerBar,
        showBeats: project.showBeats,
        tracks: project.tracks,
      },
      sources: list.map((s) => ({ id: s.id, name: s.name, file: s.file })),
    };
    zip.add('project.json', new TextEncoder().encode(JSON.stringify(meta)));
    for (let i = 0; i < list.length; i++) {
      if (onProgress) onProgress(i / list.length);
      await new Promise((r) => setTimeout(r, 0)); // let the progress bar paint
      const buf = list[i].src.buffer;
      zip.add(list[i].file, new Uint8Array(SS.encodeWav(SS.channelsOf(buf), buf.sampleRate, 32)));
    }
    return zip.toBlob('application/octet-stream');
  };

  /** Resolves to { project, sources: [{ id, name, buffer }] }. */
  SS.readProjectFile = async function (arrayBuffer) {
    let files;
    try {
      files = await SS.readZip(new Uint8Array(arrayBuffer));
    } catch (e) {
      throw new SS.UserError('That file isn’t an Audabook project, or it is damaged.');
    }
    const metaBytes = files.get('project.json');
    let meta = null;
    try {
      meta = metaBytes && JSON.parse(new TextDecoder().decode(metaBytes));
    } catch (e) { /* handled below */ }
    if (!meta || meta.format !== FORMAT) throw new SS.UserError('That file isn’t an Audabook project, or it is damaged.');
    const project = M.sanitizeProject(meta.project);
    const sources = [];
    for (const s of Array.isArray(meta.sources) ? meta.sources : []) {
      if (!s || typeof s.id !== 'string' || typeof s.file !== 'string') continue;
      const data = files.get(s.file);
      if (!data) continue;
      let buffer = null;
      try {
        SS.decodeWav(data, (numCh, frames, rate) => {
          buffer = new AudioBuffer({ numberOfChannels: numCh, length: Math.max(1, frames), sampleRate: rate });
          return SS.channelsOf(buffer);
        });
      } catch (e) {
        console.warn('Skipping damaged audio in project:', s.file, e);
        continue;
      }
      sources.push({ id: s.id, name: typeof s.name === 'string' ? s.name : 'Audio', buffer });
    }
    return { project, sources };
  };
})(window);
