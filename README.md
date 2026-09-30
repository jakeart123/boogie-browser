# Boogie Browser

A native Linux app for browsing and organizing [Eagle](https://eagle.cool) 4 libraries. It opens
the same `.library` folders Eagle uses and edits them in place, byte for byte the way Eagle writes
them, so a library can be shared (for example over Dropbox) with someone running the real Eagle on
Windows or macOS, and neither side has to change anything.

Built with Electron, Svelte 5 and TypeScript, with a SQLite index so large libraries (85,000 items
and up) stay fast.

This is an independent project. It is not made by or affiliated with the makers of Eagle.

## What it does

- Browse in justified, masonry, grid or list layouts, with a full-screen viewer and an inspector
  for tags, ratings, notes, links and folders.
- Search by keyword, tag, color, date, size and type. Smart folders and saved filters are read and
  written in Eagle's own format.
- Folders, tags, tag groups, starred tags, trash, import from files and the clipboard.
- Duplicate finder (exact and visually similar), and a triage mode for sorting new items quickly.
- Every change goes into a history kept outside the library, and any change can be undone.
- Sharing: notices changes arriving from another computer, tells you when someone else's Eagle may
  have written an older copy over your change, and lets you pick which version to keep. Dropbox
  conflicted copies of a library's files are found and can be compared.
- Eagle-compatible HTTP API (ports 41595 and 41593), so Eagle's browser extension and tools that
  talk to Eagle work with it.
- An MCP server for AI agents (port 41597, bearer token), with plan-then-apply writes.

## Requirements

- Linux (developed and tested on Wayland with Hyprland)
- Node.js 24 or newer
- libvips tools (`vips`, `vipsheader`, `vipsthumbnail`), ImageMagick (`magick`), `ffmpeg` and
  `ffprobe`
- Optional: `dropbox-cli`, used to show Dropbox sync status

## Getting started

```sh
npm ci
npm run dev          # run the app
npm run app:dist     # build an unpacked app into dist/linux-unpacked
```

`npm run dev:web` runs the interface in a browser against a copy of a test library, which is
handy for UI work.

## Safety

Every write goes through one guard. A library opens for editing only inside a folder you allow in
Settings ("Libraries Boogie may edit"). Anything inside a Dropbox folder, `~/Dropbox`, `~/Staging`,
`/run/media`, `/media` or `/mnt` stays read-only even then, until you also turn on "Allow editing
libraries in Dropbox and on external drives" in the same place. AI agents and the HTTP API can't
change either one. Any library can be set to read-only by hand. Keep a backup of any library you
care about before letting a new program edit it.

## Connecting an agent

```sh
claude mcp add --transport http boogie http://127.0.0.1:41597/mcp \
  --header "Authorization: Bearer $(cat ~/.config/boogie-browser/api-token)"
```

## Tests

```sh
npm run typecheck
BOOGIE_TEST_FIXTURES=1 npm test
```

The unit tests run on the small generated libraries in `test/fixtures/libraries`. The end-to-end
suite in `test/e2e` drives the built app under Xvfb and expects larger local sample libraries (see
`test/e2e/README.md`).

## Code layout

- `src/core`: plain Node, no Electron. Reading and writing Eagle's format (`eagle`), the SQLite
  index and queries (`index`), change watching (`sync`), undo history (`journal`), import, media
  tools, duplicate finding, the HTTP API and the MCP server.
- `src/app`: the Electron main process.
- `src/renderer`: the Svelte interface.
- `src/shared`: types and the API shared by both sides.

## License

MIT. See [LICENSE](LICENSE).
