# Audabook

A simple multitrack recorder for Chromebooks: import a beat, record over it, trim and cut, and export every track as its own WAV file, with all stems exactly the same length.

It runs inside Chrome itself, so it doesn't need Linux, Developer Mode, or an install from the Play Store. That's why it works where Audacity crashed: Audacity on a Chromebook has to run inside the Linux container, which is slow and has laggy audio on a 4 GB machine. Audabook uses Chrome's own audio system, the fastest path ChromeOS has.

The layout and keyboard shortcuts follow Audacity, but it's an independent app; no Audacity code is used.

Built for her Chromebook (Intel N150, 4 GB RAM). It also works on any Chromebook (Intel, AMD or ARM) and in desktop Chrome or Edge.

## What it does

- **Import** MP3, WAV, M4A, OGG and FLAC (File → Import Audio, the Import button, or drag files onto the window). If a beat's filename includes its tempo, like `Night Drive 140 BPM.mp3`, the tempo is set automatically.
- **Record** like a tape deck's record button:
  - **R** (or the red button) turns recording on. A red banner appears and the level meter goes live, so she can check her level before singing.
  - **Space** starts a take, and **Space** again stops it. Recording stays on, so the next Space records another take, each on its own track.
  - **R** turns recording off, and Space goes back to play/pause.
  - The beat plays while she records. With a mouse, the big ▶ button turns red and does what Space does.
  - **Plug and play mic:** a USB mic such as her Maono is picked automatically over the built-in mic, and its name shows next to the level meter. Plugging it in or out mid-session pops up a message.
  - **Music mode:** Chrome's voice-call filters (echo cancel, noise suppression, auto-volume) are off, because they ruin singing.
  - **Level help:** quiet takes are turned up automatically. A silent or distorted take gets a plain-English tip, such as "check the mute button" or "turn the gain knob down".
- **Tempo:** a BPM box, a **Tap** button (tap along to find the tempo), time signature, a metronome with a one-bar count-in, a bars-and-beats ruler, and clips that snap to the beat. The click is never included in exports.
- **Edit:** drag across a waveform to select, **Backspace** to delete, **S** to split, drag a clip's colored top bar to move it, drag its edge to trim. Cut, copy, paste, and up to 100 levels of undo. Cut points get a tiny automatic fade so they never click.
- **Export:** **File → Export → Export All Stems** (or the big **Export Stems** button).
  - Every ticked track becomes its own WAV file; tracks that are muted start unticked.
  - All stems start at 0:00 and have exactly the same number of samples, so they line up in any music app.
  - Save them into a folder she picks, or as one .zip.
  - The song's BPM goes in the folder name, for example `My Song 140 BPM stems`.
  - **Export Mix as WAV** saves the whole song as one file.
- **My Songs, nothing to remember:** every song saves itself as she works, so closing the app or the battery dying is fine.
  - **My Songs** (the button at the top right, or **Ctrl+O**) lists every song she's made, newest first. She can open, rename, back up, or delete any of them.
  - **New Song** starts a fresh one and keeps all the others. Next time she opens Audabook, the song she was last working on comes back.
  - **Back up** (in My Songs, or File → Save Backup File) saves a single `.audabook` file of one song, handy for sending a song to someone or moving it. **File → Open Backup File** adds it back as a song.
- **Songs folder, safe from "Clear browsing data":** she picks a folder once (Google Drive is best), and Audabook keeps a copy of every song there as real files, by itself, as she works.
  - Inside are one small `<Song name>.song.json` per song, an `audio/` folder with each recording, and an "About these files" note.
  - If Chrome's data is ever cleared, or she gets a new Chromebook: open Audabook, click **Find my songs folder** (or My Songs → **Keep my songs safe**), pick the folder, and every song comes back.
  - Audabook suggests this after her first song is saved. Until a folder is chosen, the My Songs button shows a small amber dot.
  - Two Chromebooks pointed at the same Drive folder share songs; the newest edit of a song wins.
- **Works offline:** after it has been opened once with internet, it works with none (recording, editing, exporting, My Songs). The Drive copy catches up when she's back online. Updates download the next time she opens it online.

## Getting it onto her Chromebook

### Install it from the web (recommended)

Audabook is live at **https://fkwhitton01.github.io/audabook/**, served free by GitHub Pages from the `docs/` folder of this repo.

1. On **her Chromebook**, open that link in Chrome.
2. Click the install icon at the right end of the address bar (a monitor with a down arrow), or use **⋮ menu → Cast, save, and share → Install page as app**.
3. Right-click the new Audabook icon in the shelf and choose **Pin**.

Now it opens in its own window like a normal app and works with no internet. Bonus: she can right-click an MP3 or WAV in the Files app and choose **Open with → Audabook**.

**Updating it later:** after changing anything in `app/`, run `npm run build` (it refreshes `docs/`), then commit and push. GitHub republishes within a minute or two, and her app picks up the new version the next time she opens it with internet.

### Backup option: one file, no website

`dist\Audabook.html` is the whole app in a single file. Copy it to her Chromebook (Google Drive, a USB stick, or email it to her), then double-click it in the Files app to open it in Chrome. Bookmark it so it's easy to find.

Downsides: there's no app icon or offline install, and Chrome treats a local file more strictly than a website. If the mic or the "save stems into a folder" option doesn't work this way, use the web link instead; exporting stems as a .zip always works. (`dist\` isn't in the repo; run `npm run build` to make the file.)

## First time, on her Chromebook

1. Plug the Maono into the Chromebook's USB port (a USB-C adapter is fine), then open Audabook.
2. Click **Import a beat or song** and pick the beat.
3. Press **R** (or the red ● button) to turn recording on. The first time, Audabook explains that Chrome is about to ask about the microphone; she clicks **Allow** once and never again.
4. Put on headphones so the beat doesn't leak into her vocal. Wired is best; Bluetooth headphones add delay.
5. Press **Space** to start singing, and **Space** again to stop. Repeat for more takes.
6. Press **R** to turn recording off. Now Space plays everything back.
7. There's no need to save: the song is already in **My Songs**. When it's finished, **File → Export → Export All Stems** makes the WAV files to share.
8. For the next song, click **My Songs → + New Song** (or File → New Song). The first song stays in My Songs.
9. When Audabook offers to **keep her songs safe**, click **Choose folder…**, then pick **Google Drive → My Drive → Open**, and click **Allow** if Chrome asks. It makes an "Audabook Songs" folder there and copies every song into it from then on. She only does this once.

The app shows a 4-step Quick Start the first time it opens (Help → Quick Start brings it back), and **Help → Microphone Help** walks through mic problems.

## Troubleshooting

| Problem | Fix |
|---|---|
| "The microphone is blocked" | Click the lock or mic icon at the left of the address bar → Microphone → Allow. In the installed app: ⋮ → App info → Permissions. |
| Takes come in silent | Check the mute button on the Maono (its light usually turns red when muted). Also check ChromeOS Settings → Security and privacy → Privacy controls → Microphone access. |
| No sound from the Chromebook after plugging in the mic | ChromeOS may have switched output to the mic's headphone jack. Plug headphones into the mic, or click the clock (bottom right) → arrow next to volume → pick the speakers. |
| Vocals sound late against the beat | Settings → Recording timing fix: slide right (try +40 ms) and record again. Bluetooth headphones need much more; use wired ones for recording. |
| A take is distorted ("crunchy") | Turn the gain knob on the mic down a little, or sing a bit further away. |
| Stems were saved as a .zip | ChromeOS can open zips: double-click it in Files, then copy the WAVs out. |
| "Out of storage space" | The Chromebook's disk is full. Back up songs she's finished (My Songs → Back up, to Google Drive), then delete them in My Songs to free space. |
| Songs are gone after clearing browsing data, a reset, or on a new Chromebook | Open Audabook, click **Find my songs folder** (or My Songs → Keep my songs safe), and pick the "Audabook Songs" folder in Google Drive. Every song comes back. (This only works if a songs folder was chosen before; otherwise use any Back up files.) |
| An orange bar says Audabook needs your OK for the songs folder | Click **Allow** on the bar. Chrome sometimes asks again (usually when Audabook is used in a browser tab instead of the installed app). |

## For you: how it's built

Plain HTML, CSS and JavaScript with no frameworks and no dependencies; Node.js is used only for tests and the build.

| Path | What it is |
|---|---|
| `app/` | The app itself: `index.html`, `css/`, `js/`, icons, offline worker |
| `app/js/model.js` | The editing model. Clips point into recorded or imported audio, so cuts never copy any audio. |
| `app/js/engine.js` | Playback, recording (AudioWorklet), metronome, and USB-mic auto-selection |
| `app/js/exporter.js` | Renders stems with `OfflineAudioContext`, so the export matches exactly what she hears |
| `app/js/timeline.js` | Waveforms, ruler, and the mouse and touch editing |
| `app/js/app.js` | Menus, shortcuts, dialogs, import/export, My Songs |
| `app/js/storage.js` | The song library in IndexedDB (each song plus its audio); moves songs saved by the first version into My Songs |
| `app/js/songsfolder.js` | The songs folder: writes songs as real files (File System Access API) and syncs them with My Songs, newest copy winning |
| `test/` | Unit tests for editing, WAV and ZIP |
| `tools/` | Build, local server, icon and test-audio generators |
| `docs/` | The built web app that GitHub Pages publishes (made by `npm run build`; don't edit by hand) |
| `dist/` | Local build output: `Audabook.html` (single file) and `web/` (not committed) |

Commands (Node 18 or newer):

```bash
npm test
```

```bash
npm run build
```

```bash
npm run serve
```

`npm run serve` serves `app/` at http://localhost:5173. `npm run test-audio` writes sample beats into `test-audio/`.

Memory: on a 4 GB Chromebook the app keeps at most about 400 MB of audio around for undo. Past that, the oldest undo steps are dropped instead of risking a crashed tab. A typical song (a stereo beat plus several vocal takes) uses well under that.

Some icons are adapted from Google's Material Icons (Apache License 2.0).
