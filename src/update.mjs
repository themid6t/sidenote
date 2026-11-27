// Is a newer release out? Asks GitHub at most once a day (cached in update-check.json); off with
// SIDENOTE_NO_UPDATE_CHECK=1. Never throws: on any failure the answer is just "no".
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';

export const VERSION = process.env.SIDENOTE_VERSION || 'dev';
export const REPO = 'themid6t/sidenote';

const isNewer = (v) => !!v && v.localeCompare(VERSION, undefined, { numeric: true }) > 0;

/** The latest version if it's newer than this one, else null. */
export async function newerVersion() {
  if (VERSION === 'dev' || process.env.SIDENOTE_NO_UPDATE_CHECK) return null;
  const file = path.join(store.HOME, 'update-check.json');
  let last = {};
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (Date.now() - (last.at || 0) > 864e5) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(5000) });
      last = { at: Date.now(), latest: String((await r.json()).tag_name || '').replace(/^v/, '') };
      fs.mkdirSync(store.HOME, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(last));
    } catch {}
  }
  return isNewer(last.latest) ? last.latest : null;
}
