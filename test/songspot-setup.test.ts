import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
const game = await import(pathToFileURL(`${process.cwd()}/web/songspot/game.mjs`).href);
const presets = await import(pathToFileURL(`${process.cwd()}/web/songspot/presets.mjs`).href);
class Element {
  children: Element[] = []; dataset: Record<string, string> = {}; textContent = ''; value: string | number = ''; max = 0; disabled = false;
  hidden = false; checked = false; open = false; onclick?: () => unknown; onchange?: () => unknown; onsubmit?: (event: any) => unknown;
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = items; }
  setAttribute() {}
}
const artist = { id: 412, name: 'Queen' };
const releases = [{ id: 10, title: 'Queen II', record_type: 'album' }, { id: 20, title: 'Queen II (Deluxe Edition)', record_type: 'album' }, { id: 30, title: 'An EP', record_type: 'ep' }];
const submit = { preventDefault() {} };
async function settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }
function setup(storage: any, failCatalog = false) {
  const elements = new Map<string, Element>();
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  element('game').hidden = true; element('start').disabled = true;
  const paths: string[] = [];
  const events = new Map<string, () => void>();
  const audio = { src: '', currentTime: 0, paused: true, plays: 0, pauses: 0,
    addEventListener: (event: string, callback: () => void) => { const prior = events.get(event); events.set(event, () => { prior?.(); callback(); }); },
    pause() { this.paused = true; this.pauses++; events.get('pause')?.(); },
    async play() { this.paused = false; this.plays++; events.get('playing')?.(); }
  };
  const timers = new Map<number, () => void>(); let timer = 0;
  class TestPlayer extends game.ClipPlayer {
    constructor(media: unknown) { super(media, (callback: () => void) => { timers.set(++timer, callback); return timer; }, (key: number) => timers.delete(key)); }
  }
  const source = readFileSync('web/songspot/app.mjs', 'utf8').replace(/^import .*;\n/gm, '');
  runInNewContext(source, {
    ...game, ...presets, ClipPlayer: TestPlayer, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, localStorage: storage, AbortSignal, Number, Map, Set,
    document: { getElementById: element, createElement: () => new Element(), addEventListener() {} },
    window: { addEventListener() {} }, Audio: class { constructor() { return audio; } },
    fetch: async (path: string) => {
      paths.push(path);
      if (path.includes('/albums') && failCatalog) throw Error('Catalog failed');
      const data = path.startsWith('api/artists?q=') ? [artist] : path.startsWith('api/artists/') ? releases : [{ id: Number(path.match(/albums\/(\d+)/)?.[1]), title: `Track from ${path}`, artist, preview: 'https://example.com/audio' }];
      return { ok: true, json: async () => ({ data }) };
    }
  });
  return { element, paths, audio, events, timers };
}
async function choose(app: ReturnType<typeof setup>) {
  app.element('artist-query').value = 'Queen';
  await app.element('artist-search').onsubmit!(submit);
  app.element('search-results').children[0].children[0].onclick!();
  await settle();
}
test('setup recommends albums and EPs, saves custom choices and reloads an artist playlist', async () => {
  let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  const app = setup(storage); await choose(app);
  let panel = app.element('selected').children[0];
  assert.equal(panel.children[0].textContent, 'Queen · 2 releases selected');
  const list = panel.children.find(child => child.children.length === 3)!;
  const standard = list.children[0].children[0], deluxe = list.children[1].children[0];
  standard.checked = false; standard.onchange!(); deluxe.checked = true; deluxe.onchange!();
  panel.children.find(child => child.textContent === 'Save artist preset')!.onclick!();
  app.element('playlist-name').value = 'Favorites'; app.element('playlist-form').onsubmit!(submit);
  const reloaded = setup(storage);
  reloaded.element('playlist-list').children[0].children[0].onclick!(); await settle();
  panel = reloaded.element('selected').children[0];
  const reloadedList = panel.children.find(child => child.children.length === 3)!;
  assert.deepEqual(reloadedList.children.map(child => child.children[0].checked), [false, true, true]);
  await reloaded.element('start').onclick!();
  assert.equal(reloaded.element('game').hidden, false);
  assert.ok(reloaded.paths.includes('api/albums/20/tracks?limit=100&index=0'));
  assert.ok(reloaded.paths.includes('api/albums/30/tracks?limit=100&index=0'));
  assert.equal(reloaded.paths.some(path => path.includes('albums/10/tracks')), false);
});
test('an empty saved selection is preserved and failed catalogs disable starting', async () => {
  const storage = { getItem: () => JSON.stringify({ version: 1, artists: { '412': [] }, playlists: [] }), setItem() {} };
  const app = setup(storage); await choose(app);
  assert.equal(app.element('start').disabled, true);
  assert.equal(app.element('selected').children[0].children[0].textContent, 'Queen · 0 releases selected');
  const failed = setup(storage, true); await choose(failed);
  assert.equal(failed.element('start').disabled, true);
  assert.ok(failed.element('selected').children[0].children.some(child => child.textContent === 'Retry'));
});
test('storage write failures keep current album choices playable', async () => {
  const app = setup({ getItem: () => null, setItem: () => { throw Error('Storage full'); } });
  await choose(app);
  const panel = app.element('selected').children[0];
  panel.children.find(child => child.textContent === 'Save artist preset')!.onclick!();
  assert.match(app.element('status').textContent, /Could not save/);
  assert.equal(app.element('start').disabled, false);
  await app.element('start').onclick!();
  assert.equal(app.element('game').hidden, false);
  assert.equal(app.paths.some(path => path.includes('albums/20/tracks')), false);
});

test('timeline follows playback and skip extends it without restarting; replay and next reset', async () => {
  const app = setup({ getItem: () => null, setItem() {} }); await choose(app);
  await app.element('start').onclick!();
  assert.equal(app.element('segment-time').textContent, '0.0s / 0.5s');
  app.element('play').onclick!(); await settle();
  app.audio.currentTime = .3; app.events.get('timeupdate')!();
  assert.equal(app.element('segment-progress').value, .3);
  assert.equal(app.element('segment-time').textContent, '0.3s / 0.5s');
  const pauses = app.audio.pauses;
  app.element('skip').onclick!(); await settle();
  assert.equal(app.audio.currentTime, .3); assert.equal(app.audio.plays, 1); assert.equal(app.audio.pauses, pauses);
  assert.equal(app.element('segment-progress').max, 2);
  assert.equal(app.element('segment-time').textContent, '0.3s / 2s');
  app.audio.currentTime = 2; app.events.get('timeupdate')!();
  assert.equal(app.audio.paused, true);
  app.element('skip').onclick!(); await settle();
  assert.equal(app.audio.currentTime, 2); assert.equal(app.audio.plays, 2);
  app.element('play').onclick!(); await settle();
  assert.equal(app.audio.currentTime, 0); assert.equal(app.element('segment-time').textContent, '0.0s / 8s');
  app.audio.currentTime = 3;
  app.element('next').onclick!();
  assert.equal(app.element('segment-progress').value, 0);
  assert.equal(app.element('segment-time').textContent, '0.0s / 0.5s');
});
