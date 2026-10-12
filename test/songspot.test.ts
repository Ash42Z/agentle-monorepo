import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const game = await import(pathToFileURL(`${process.cwd()}/web/songspot/game.mjs`).href);
const track = { id: 1, title: 'Déjà Vu!', artist: { id: 7, name: 'Artist' }, preview: 'https://example.com/preview.mp3' };
test('wrong guesses and skips expand the same clip and finish after 15 seconds', () => {
  const round = new game.Round(track);
  assert.equal(round.seconds, .5);
  assert.equal(round.submit('wrong'), 'longer'); assert.equal(round.seconds, 2);
  assert.equal(round.submit(''), 'longer'); assert.equal(round.seconds, 8);
  assert.equal(round.submit('wrong'), 'longer'); assert.equal(round.seconds, 15);
  assert.equal(round.done, false);
  assert.equal(round.submit(''), 'finished'); assert.equal(round.done, true);
  assert.equal(round.submit('Déjà Vu!'), 'finished'); assert.equal(round.won, false);
});
test('correct guesses tolerate punctuation, accents and case at every stage', () => {
  for (let stage = 0; stage < 4; stage++) {
    const round = new game.Round(track);
    for (let i = 0; i < stage; i++) round.submit('');
    assert.equal(round.submit('  DEJA vu '), 'correct');
    assert.equal(round.won, true); assert.equal(round.done, true);
  }
});
test('catalog excludes unavailable previews and duplicate song versions', () => {
  assert.deepEqual(game.playableTracks([track, { ...track, id: 2 }, { ...track, preview: '' }, { ...track, artist: undefined }]), [track]);
});
test('base song titles are accepted without a mix or featured artist suffix', () => {
  const round = new game.Round({ ...track, title: 'Get Lucky (Radio Edit)', title_short: 'Get Lucky' });
  assert.equal(round.submit('Get Lucky'), 'correct');
});
test('replays reset audio and cancel old timers; stop cancels playback', async () => {
  const timers = new Map<number, { callback: () => void, delay: number }>(); let id = 0, pauses = 0;
  const audio = { src: '', currentTime: 12, pause: () => pauses++, play: async () => {} };
  const player = new game.ClipPlayer(audio, (callback: () => void, delay: number) => { timers.set(++id, { callback, delay }); return id; }, (key: number) => timers.delete(key));
  await player.play(track.preview, .5);
  assert.equal(audio.currentTime, 0); assert.equal(timers.get(1)?.delay, 500);
  audio.currentTime = .4;
  await player.play(track.preview, 2);
  assert.equal(audio.currentTime, 0); assert.equal(timers.has(1), false); assert.equal(timers.get(2)?.delay, 2000);
  timers.get(2)!.callback(); assert.equal(timers.size, 0); assert.equal(pauses, 3);
});
test('pending playback cannot schedule a stale timer after stop', async () => {
  let resolve!: () => void, scheduled = false;
  const player = new game.ClipPlayer({ src: '', currentTime: 0, pause() {}, play: () => new Promise<void>(r => { resolve = r; }) }, () => { scheduled = true; }, () => {});
  const pending = player.play(track.preview, 15); player.stop(); resolve(); await pending;
  assert.equal(scheduled, false);
});
test('default timer functions are called without a player receiver in browsers', async () => {
  const source = readFileSync('web/songspot/game.mjs', 'utf8').replace(/export /g, '');
  const context: any = {
    audio: { src: '', currentTime: 0, play: async () => {}, pause() {} },
    setTimeout: function(this: unknown) { assert.equal(this, undefined); return 1; },
    clearTimeout: function(this: unknown) { assert.equal(this, undefined); },
  };
  runInNewContext(`${source}\nglobalThis.player = new ClipPlayer(audio);`, context);
  await context.player.play(track.preview, .5);
  context.player.stop();
});
test('studio catalog excludes EPs, singles and labelled non-studio releases', () => {
  assert.equal(game.studioAlbum({ record_type: 'album', title: 'A Night at the Opera' }), true);
  for (const title of ['Live at Wembley', 'Greatest Hits', 'The Remix Collection', 'Anthology', 'Unplugged']) {
    assert.equal(game.studioAlbum({ record_type: 'album', title }), false);
  }
  for (const record_type of ['ep', 'single', undefined]) {
    assert.equal(game.studioAlbum({ record_type, title: 'Songs' }), false);
  }
  assert.equal(game.studioTrack({ title: 'Song', title_version: '(Live)' }), false);
  assert.equal(game.studioTrack({ title: 'Song (Remix)' }), false);
  assert.equal(game.studioTrack({ title: 'Song' }), true);
  assert.equal(game.studioTrack({ title: 'Live Forever' }), true);
  assert.equal(game.studioTrack({ title: 'Song - Live at Wembley' }), false);
  assert.equal(game.studioTrack({ title: 'Song (Demo)' }), false);
  assert.equal(game.studioTrack({ title: 'Song', title_version: 'Rough Mix' }), false);
});
test('studio mode filters selected releases without changing saved choices', () => {
  const albums = [
    { id: 1, record_type: 'album', title: 'A Night at the Opera' },
    { id: 2, record_type: 'album', title: 'Live at Wembley' },
    { id: 3, record_type: 'ep', title: 'Studio EP' },
    { id: 4, record_type: 'album', title: 'Greatest Hits' },
    { id: 5, record_type: 'album', title: 'Remixes' },
    { id: 6, record_type: 'album', title: 'B-Sides' },
    { id: 7, record_type: 'album', title: 'Unselected studio album' },
  ];
  const ids = new Set([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(game.selectedReleases(albums, ids, true), [1]);
  assert.deepEqual([...ids], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(game.selectedReleases(albums, ids, false), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(game.selectedReleases(albums, new Set(), true), []);
});
test('catalog follows pagination using local routes and stops on empty pages', async () => {
  const paths: string[] = [];
  const result = await game.catalog(async (path: string) => {
    paths.push(path);
    return paths.length === 1 ? { data: [{ id: 1 }], next: 'https://untrusted.example' } : { data: [{ id: 2 }] };
  }, 'artists/7/albums');
  assert.deepEqual(result, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(paths, ['artists/7/albums?limit=100&index=0', 'artists/7/albums?limit=100&index=100']);
  let calls = 0;
  assert.deepEqual(await game.catalog(async () => { calls++; return { data: [], next: 'more' }; }, 'albums/1/tracks'), []);
  assert.equal(calls, 1);
});
