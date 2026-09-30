# End-to-end tests (the real app)

These drive the **built Electron app with the real core** on private copies of local sample
libraries, the way you'd use it: clicks, keys, drags, dialogs. Every test that edits something
checks the library files on disk afterwards (`metadata.json`, `mtime.json`, the root file).

The suite expects two local sample libraries in `research/sandbox/templates/`: `sample.library`
and `art-archive.library` (a large one, about 5.4k items). They are not in the repo, so on a fresh
clone this suite can't run. The unit tests, `npm run dev:web` and the smoke test (`npm run e2e`)
fall back to the small libraries in `test/fixtures/libraries/` when they are missing.

## Run

```sh
mise exec -- npm run e2e:full                  # build, then every file (about 2.5 minutes)
mise exec -- npm run e2e:full -- viewer search # only files whose name contains a word
mise exec -- npm run e2e:full -- --no-build    # reuse the last build
```

`run.mjs` builds into `.tmp/electron-qa/out`, starts its own Xvfb display, removes
`WAYLAND_DISPLAY`, and runs `node --test` on `test/e2e/*.e2e.mjs` one file at a time. Nothing
reaches the desktop or the real clipboard: the launch helper refuses to start Electron unless
`DISPLAY` is that Xvfb and `WAYLAND_DISPLAY` is unset, and `xclip` runs against the same display.

Everything the app writes lands in `.tmp/electron-qa/`:

- `libs/` fresh reflinked copies of `research/sandbox/templates/sample.library` (one per test
  file) and one shared read-only copy of the Art Archive (`art.library`, 5.4k items)
- `home/<file>/` the `BOOGIE_HOME` of each test file (config, index, journal)
- `fixtures/` small images, a GIF, two videos and a folder tree made with `magick` / `ffmpeg`
- `shots/<file>-FAIL-<test>.png` a screenshot of the window whenever a test fails

## Files

| File                 | What it covers                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `library.e2e.mjs`    | startup picker, open, switch, recent order, open other, create, remove, reopen on restart                                         |
| `browse.e2e.mjs`     | scopes vs disk, Random, subfolder contents, tags, back/forward, 4 layouts, zoom, 5.4k scroll timing                               |
| `selection.e2e.mjs`  | click, Ctrl/Shift+click, rubber band, Ctrl+A, Escape, arrow keys                                                                  |
| `items.e2e.mjs`      | rename, notes, URL, tags, rating, batch edits, trash / restore / delete / empty trash                                             |
| `folders.e2e.mjs`    | folders (create, rename, color, auto-tags, move, reorder, sort, delete), drag items onto folders, manual order                    |
| `search.e2e.mjs`     | keyword grammar, every filter popover, chips                                                                                      |
| `inspector.e2e.mjs`  | palette color search, preview, folder info editing                                                                                |
| `viewer.e2e.mjs`     | detail view, quick look, video, GIF, hover previews, compare, slideshow, reference window                                         |
| `formats.e2e.mjs`    | PSD / TIFF previews, AVIF / WebP, PDF viewer                                                                                      |
| `import.e2e.mjs`     | file drops, duplicate question, + menu imports, folder tree, paste, URL and data: drops                                           |
| `files-out.e2e.mjs`  | Ctrl+C, copy path, reveal, open, source link, drag out, export, double-click setting                                              |
| `history.e2e.mjs`    | undo / redo keys, undo of every kind of change, History tab, changes from the partner's Eagle, status strip                       |
| `dupes.e2e.mjs`      | duplicate finder: exact, similar, merge, merge all, undo                                                                          |
| `pickers.e2e.mjs`    | tag window, folder picker, Shift+D, go to folder, move, rename, batch rename, palette, shortcuts                                  |
| `smart-tags.e2e.mjs` | smart folders, quick access, tag manager, tag groups                                                                              |
| `readonly.e2e.mjs`   | a library outside the editable places, "Allow editing…", "Open read-only"                                                         |
| `servers.e2e.mjs`    | Eagle HTTP API and extension port (moved with `BOOGIE_EAGLE_API_PORT` / `BOOGIE_EXTENSION_PORT`), MCP over raw JSON-RPC, Settings |

`lib/harness.mjs` launches the app (`launch({ name, open, readOnly, settings, env })`) and has
the disk helpers; `lib/ui.mjs` has the DOM helpers, the synthesized drops (real file paths, via a
hidden file input) and the stubs for the native drag, the file dialogs and the shell.
