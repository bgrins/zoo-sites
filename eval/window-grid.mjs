// Headed window tiling, shared by run.mjs and verify.mjs. Firefox reads window
// geometry out of a profile's xulstore.json at startup, so every browser we can
// hand a seeded profile to (stdio firefox-devtools-mcp via --profile-path;
// @playwright/mcp has no window-position knob) claims one cell of a
// screen-sized grid. Slots past capacity wrap with a cascade offset so stacked
// windows stay distinguishable.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Usable desktop area in top-left-origin coordinates.
const DEFAULT_SCREEN = { w: 1920, h: 1040, top: 40, left: 0 };

// `override` is a --screen value (WxH) or null to detect.
export function detectScreen(override = null) {
  if (override) {
    const m = override.match(/^(\d+)x(\d+)$/);
    if (!m) {
      throw new Error(`--screen must look like 1920x1080, got "${override}"`);
    }
    return { w: Number(m[1]), h: Number(m[2]) - 40, top: 40, left: 0 };
  }
  if (process.platform === 'darwin') {
    // NSScreen.visibleFrame excludes the menu bar and Dock, and (unlike
    // AppleScript app automation) needs no TCC permission. AppKit frames are
    // bottom-left-origin; convert the top offset.
    const out = spawnSync('osascript', [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("AppKit"); const s = $.NSScreen.mainScreen; const v = s.visibleFrame; ' +
        'JSON.stringify({w: v.size.width, h: v.size.height, left: v.origin.x, ' +
        'top: s.frame.size.height - v.origin.y - v.size.height})',
    ]);
    try {
      const v = JSON.parse(String(out.stdout ?? ''));
      return { w: v.w, h: v.h, top: v.top, left: v.left };
    } catch {
      return DEFAULT_SCREEN;
    }
  }
  return DEFAULT_SCREEN;
}

// A grid of `slots` cells over `screen`. `seed(stateDir, slot)` writes the
// profile a browser should launch with and returns its path.
export function windowGrid(slots, screen = DEFAULT_SCREEN) {
  const cols = Math.ceil(Math.sqrt(slots));
  const rows = Math.ceil(slots / cols);
  const capacity = cols * rows;
  const width = Math.floor(screen.w / cols);
  const height = Math.floor(screen.h / rows);
  return {
    seed(stateDir, slot) {
      const profileDir = join(stateDir, 'profile');
      mkdirSync(profileDir, { recursive: true });
      // firefox-devtools-mcp resolves --profile-path as a PARENT directory and
      // launches Firefox from <dir>/firefox_devtools_mcp_profile, so the
      // geometry has to land there; seed the parent too, in case a version
      // takes the path it was given.
      const nested = join(profileDir, 'firefox_devtools_mcp_profile');
      mkdirSync(nested, { recursive: true });
      const cell = slot % capacity;
      const cascade = Math.floor(slot / capacity) * 30;
      const geometry = {
        'chrome://browser/content/browser.xhtml': {
          'main-window': {
            screenX: String(screen.left + (cell % cols) * width + cascade),
            screenY: String(screen.top + Math.floor(cell / cols) * height + cascade),
            width: String(width),
            height: String(height),
            sizemode: 'normal',
          },
        },
      };
      const json = JSON.stringify(geometry);
      writeFileSync(join(profileDir, 'xulstore.json'), json);
      writeFileSync(join(nested, 'xulstore.json'), json);
      return profileDir;
    },
  };
}
