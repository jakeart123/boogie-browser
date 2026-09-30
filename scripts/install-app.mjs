#!/usr/bin/env node
// Installs the built app for this user (no root, no package manager):
//   dist/linux-unpacked  ->  ~/.local/opt/boogie-browser
//   a launcher entry     ->  ~/.local/share/applications/boogie-browser.desktop
//   the icon             ->  ~/.local/share/icons/hicolor/512x512/apps/boogie-browser.png
// Run `npm run app:dist` first (or `npm run app:install`, which does both). Running it again updates
// the install. It does NOT make Boogie the default handler for eagle:// links (Eagle under Wine may own those).
// Close Boogie Browser first if it is running: a running copy may fail to load pieces of the deleted old one.
//   node scripts/install-app.mjs [--home <dir>] [--from <dir>]
//   (--home installs under <dir> instead of your real home, --from installs another build folder; both are for testing)
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const home = args.includes('--home') ? resolve(args[args.indexOf('--home') + 1]) : homedir();

const source = args.includes('--from')
  ? resolve(args[args.indexOf('--from') + 1])
  : join(root, 'dist/linux-unpacked');
if (!existsSync(join(source, 'boogie-browser'))) {
  console.error('There is no build to install. Run `npm run app:dist` first.');
  process.exit(1);
}

if (spawnSync('pgrep', ['-x', 'boogie-browser'], { stdio: 'ignore' }).status === 0) {
  console.warn(
    'Boogie Browser looks like it is running. Close it, then run this again for a clean update.',
  );
}

const dest = join(home, '.local/opt/boogie-browser');
const applications = join(home, '.local/share/applications');
const iconDir = join(home, '.local/share/icons/hicolor/512x512/apps');

// Copy next to the target, then swap: a running copy keeps working, and a failed copy leaves the old install alone.
const staging = `${dest}.new`;
mkdirSync(dirname(dest), { recursive: true });
rmSync(staging, { recursive: true, force: true });
cpSync(source, staging, { recursive: true });
rmSync(`${dest}.old`, { recursive: true, force: true });
if (existsSync(dest)) renameSync(dest, `${dest}.old`);
renameSync(staging, dest);
rmSync(`${dest}.old`, { recursive: true, force: true });

mkdirSync(iconDir, { recursive: true });
copyFileSync(join(root, 'resources/icon.png'), join(iconDir, 'boogie-browser.png'));

// A path with spaces has to be quoted in Exec (desktop entry spec).
const exec = join(dest, 'boogie-browser');
const desktop = `[Desktop Entry]
Type=Application
Name=Boogie Browser
Comment=Browse and edit Eagle libraries
Exec=${/\s/.test(exec) ? `"${exec}"` : exec} %U
Icon=boogie-browser
Terminal=false
Categories=Graphics;
MimeType=x-scheme-handler/eagle;
StartupNotify=true
# The window class Electron reports (src/app/main.ts pins it): what Hyprland window rules match.
StartupWMClass=boogie-browser
`;
mkdirSync(applications, { recursive: true });
writeFileSync(join(applications, 'boogie-browser.desktop'), desktop);

// Best effort: refresh the launcher and icon caches if the tools exist.
spawnSync('update-desktop-database', [applications], { stdio: 'ignore' });
spawnSync('gtk-update-icon-cache', ['-f', '-t', join(home, '.local/share/icons/hicolor')], {
  stdio: 'ignore',
});

console.log(`Installed Boogie Browser to ${dest}`);
console.log(`Launcher: ${join(applications, 'boogie-browser.desktop')}`);
console.log(
  'To open eagle:// links with it: xdg-mime default boogie-browser.desktop x-scheme-handler/eagle',
);
