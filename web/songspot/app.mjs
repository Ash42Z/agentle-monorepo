import { defaultAlbums, readLibrary, writeLibrary } from './presets.mjs';
import { Round, ClipPlayer, lengths, playableTracks, catalog } from './game.mjs';
const $ = id => document.getElementById(id);
const selected = new Map(), cache = new Map(), albumStates = new Map();
let busy = false, library = { version: 1, artists: {}, playlists: [] }, storageReady = true;
let tracks = [], deck = [], round, count = 0, wins = 0, points = 0, searchVersion = 0;
const audio = new Audio(), player = new ClipPlayer(audio);
audio.preload = 'none';
const status = text => { $('status').textContent = text; };
async function api(path) {
  const response = await fetch(`api/${path}`, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('Music search is unavailable. Please try again.');
  const result = await response.json();
  if (result.error || !Array.isArray(result.data)) throw Error('Deezer could not return songs. Please try again shortly.');
  return result;
}
try { library = readLibrary(localStorage); }
catch { storageReady = false; status('Saved presets could not be read. You can still choose albums and play.'); }
function saveLibrary(next) {
  if (!storageReady) { status('Browser storage is unavailable; presets could not be saved.'); return false; }
  try { writeLibrary(localStorage, next); library = next; return true; }
  catch { status('Could not save. Browser storage may be disabled or full. Your current selection is still available.'); return false; }
}
function button(text, action) {
  const element = document.createElement('button'); element.type = 'button'; element.className = 'secondary'; element.textContent = text; element.onclick = action; element.disabled = busy; return element;
}
function artistChips() {
  const open = new Set([...$('selected').children].filter(panel => panel.open).map(panel => panel.dataset.artist));
  $('selected').replaceChildren(...Array.from(selected.values(), artist => {
    const panel = document.createElement('details'); panel.className = 'album-panel'; panel.dataset.artist = String(artist.id); panel.open = open.has(String(artist.id));
    const state = albumStates.get(artist.id);
    const summary = document.createElement('summary');
    summary.textContent = `${artist.name} · ${state?.albums ? `${state.ids.size} releases selected` : state?.error ? 'Could not load releases' : 'Loading releases…'}`;
    panel.append(summary);
    panel.append(button('Remove artist', () => { selected.delete(artist.id); artistChips(); }));
    if (state?.error) panel.append(button('Retry', () => { albumStates.delete(artist.id); void loadAlbums(artist); }));
    if (state?.albums) {
      panel.append(button('Recommended', () => { state.ids = defaultAlbums(state.albums); artistChips(); }),
        button('Select all', () => { state.ids = new Set(state.albums.map(a => a.id)); artistChips(); }),
        button('Clear', () => { state.ids.clear(); artistChips(); }),
        button('Save artist preset', () => {
          if (saveLibrary({ ...library, artists: { ...library.artists, [artist.id]: [...state.ids] } })) status(`Album preset saved for ${artist.name}.`);
        }));
      if (Object.hasOwn(library.artists, artist.id)) panel.append(button('Forget saved preset', () => {
        const artists = { ...library.artists }; delete artists[artist.id];
        if (saveLibrary({ ...library, artists })) { status(`Saved preset removed for ${artist.name}.`); artistChips(); }
      }));
      const list = document.createElement('div'); list.className = 'album-list';
      for (const album of state.albums) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.ids.has(album.id); checkbox.disabled = busy;
        checkbox.onchange = () => { if (checkbox.checked) state.ids.add(album.id); else state.ids.delete(album.id); summary.textContent = `${artist.name} · ${state.ids.size} releases selected`; updateStart(); };
        const text = document.createElement('span'); text.textContent = `${album.title} · ${album.release_date || 'Unknown date'} · ${album.record_type || 'Release'}`;
        label.append(checkbox);
        if (/^https:\/\//.test(album.cover_medium || '')) { const cover = document.createElement('img'); cover.src = album.cover_medium; cover.alt = ''; cover.loading = 'lazy'; label.append(cover); }
        label.append(text); list.append(label);
      }
      panel.append(list);
      const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Recommended releases are a best effort. Expanded editions and labelled live/compilation releases start unchecked. You can include any release.'; panel.append(hint);
    }
    return panel;
  }));
  updateStart();
}
function updateStart() {
  $('start').disabled = busy || !selected.size || [...selected.keys()].some(id => !albumStates.get(id)?.albums) || ![...selected.keys()].some(id => albumStates.get(id)?.ids.size);
}
async function loadAlbums(artist) {
  if (albumStates.has(artist.id)) { artistChips(); return; }
  const state = { ids: new Set() }; albumStates.set(artist.id, state); artistChips();
  try {
    state.albums = (await catalog(api, `artists/${artist.id}/albums`)).filter(a => Number.isSafeInteger(a.id) && a.id > 0 && typeof a.title === 'string');
    state.ids = Object.hasOwn(library.artists, artist.id) ? new Set(library.artists[artist.id].filter(id => state.albums.some(a => a.id === id))) : defaultAlbums(state.albums);
  } catch (error) { state.error = true; status(error.message); }
  artistChips();
}
function renderPlaylists() {
  $('playlist-list').replaceChildren(...library.playlists.map(playlist => {
    const row = document.createElement('div'); row.className = 'playlist-row';
    row.append(button(`${playlist.name} · ${playlist.artists.length} artists — Load`, () => {
      selected.clear();
      for (const artist of playlist.artists) { selected.set(artist.id, artist); }
      artistChips(); for (const artist of selected.values()) void loadAlbums(artist);
      status(`Loaded ${playlist.name}. Album choices use your artist presets or current choices.`);
    }), button('Delete', () => {
      if (saveLibrary({ ...library, playlists: library.playlists.filter(p => p.name !== playlist.name) })) renderPlaylists();
    })); return row;
  }));
  $('save-playlist').disabled = busy;
}
$('playlist-form').onsubmit = event => {
  event.preventDefault(); const name = $('playlist-name').value.trim();
  if (!name || !selected.size) { status('Choose artists and enter a playlist name first.'); return; }
  if (library.playlists.some(p => p.name === name)) { status('That playlist name already exists. Use a different name or delete the old playlist.'); return; }
  const playlist = { name, artists: [...selected.values()].map(({ id, name }) => ({ id, name })) };
  if (saveLibrary({ ...library, playlists: [...library.playlists, playlist] })) { renderPlaylists(); status(`Saved ${name}. Save artist presets separately to remember album choices.`); }
};
renderPlaylists();
$('artist-search').onsubmit = async event => {
  event.preventDefault(); const version = ++searchVersion;
  const query = $('artist-query').value.trim(); if (!query) return;
  status('Finding artists…'); $('search-results').replaceChildren();
  try {
    const { data: artists } = await api(`artists?q=${encodeURIComponent(query)}`);
    if (version !== searchVersion) return;
    $('search-results').replaceChildren(...artists.filter(a => Number.isSafeInteger(a.id) && a.id > 0 && typeof a.name === 'string').map(artist => {
      const card = document.createElement('div'); card.className = 'artist-card';
      const button = document.createElement('button');
      if (/^https:\/\//.test(artist.picture_medium || '')) {
        const photo = document.createElement('img'); photo.src = artist.picture_medium; photo.alt = ''; photo.loading = 'lazy'; button.append(photo);
      }
      const details = document.createElement('span'); details.textContent = `+ ${artist.name}`;
      const info = document.createElement('small'); info.textContent = `${Number(artist.nb_album) || 0} albums · ${(Number(artist.nb_fan) || 0).toLocaleString()} fans · ID ${artist.id}`;
      details.append(info); button.append(details);
      const profile = document.createElement('a'); profile.href = `https://www.deezer.com/artist/${artist.id}`; profile.target = '_blank'; profile.rel = 'noopener noreferrer'; profile.textContent = 'View artist ↗';
      card.append(button, profile);
      button.onclick = () => {
        if (busy) return; selected.set(artist.id, artist); void loadAlbums(artist); status(`${artist.name} selected.`);
      }; return card;
    }));
    status(artists.length ? 'Choose an artist from the results.' : 'No artists found. Try another name.');
  } catch (error) { if (version === searchVersion) status(error.message); }
};
$('start').onclick = async () => {
  if (busy || $('start').disabled) return;
  busy = true; artistChips(); renderPlaylists(); status('Finding playable songs…');
  const artists = [...selected.values()];
  try {
    const results = [];
    // Snapshot choices and load sequentially to avoid flooding Deezer.
    const choices = artists.map(artist => ({ artist, ids: [...albumStates.get(artist.id).ids] }));
    for (const { artist, ids } of choices) {
      for (const id of ids) {
        if (!cache.has(id)) cache.set(id, await catalog(api, `albums/${id}/tracks`));
        results.push(cache.get(id).filter(track => track.artist?.id === artist.id));
      }
    }
    tracks = playableTracks(results.flat());
    if (!tracks.length) throw Error('No playable previews for these artists. Please choose another artist.');
    searchVersion++; $('setup').hidden = true; $('game').hidden = false;
    deck = []; count = wins = points = 0;
    $('songs').replaceChildren(...tracks.map(track => { const option = document.createElement('option'); option.value = track.title; option.label = track.artist.name; return option; }));
    nextRound();
  } catch (error) { status(error.message); }
  finally { busy = false; artistChips(); renderPlaylists(); }
};
function updateTimeline() {
  if (!round) return;
  const elapsed = Math.min(round.seconds, Math.max(0, audio.currentTime || 0));
  $('segment-progress').max = lengths.at(-1);
  $('segment-progress').value = elapsed;
  $('segment-time').textContent = `${elapsed.toFixed(1)}s / ${lengths.at(-1)}s`;
}
let timelineFrame;
function animateTimeline() {
  updateTimeline();
  if (!audio.paused) timelineFrame = requestAnimationFrame(animateTimeline);
}
audio.addEventListener('playing', () => { cancelAnimationFrame(timelineFrame); animateTimeline(); });
for (const event of ['timeupdate', 'pause', 'ended', 'seeking']) audio.addEventListener(event, updateTimeline);
function render() {
  updateTimeline();
  $('round-number').textContent = `ROUND ${count}`;
  $('score').textContent = `${wins} guessed · ${points} points`;
  $('duration').textContent = `${round.seconds} seconds · replay as often as you like`;
  $('steps').replaceChildren(...lengths.map((seconds, index) => {
    const li = document.createElement('li');
    li.style.left = `${seconds / lengths.at(-1) * 100}%`;
    const label = document.createElement('span'); label.textContent = `${seconds}s`; li.append(label);
    if (index <= round.step) li.className = 'unlocked';
    if (index === round.step) { li.className += ' active'; li.setAttribute('aria-current', 'step'); }
    return li;
  }));
  $('guess-form').hidden = $('skip').hidden = round.done;
  $('next').hidden = $('answer').hidden = !round.done;
  $('skip').textContent = round.step === 3 ? 'Reveal song' : 'Skip → hear more';
  $('guess').value = '';
  if (round.done) {
    $('answer-title').textContent = round.track.title; $('answer-artist').textContent = round.track.artist.name;
    $('deezer').href = `https://www.deezer.com/track/${Number(round.track.id)}`;
  }
}
function nextRound() {
  player.stop(); audio.currentTime = 0;
  if (!deck.length) {
    deck = [...tracks];
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    if (deck.length > 1 && deck.at(-1).id === round?.track.id) [deck[0], deck[deck.length - 1]] = [deck.at(-1), deck[0]];
  }
  round = new Round(deck.pop()); count++; render(); status('Listen to the first half second, then take a guess.');
}
async function play(extend = false) {
  const active = round;
  try { await player[extend ? 'extend' : 'play'](active.track.preview, active.seconds); updateTimeline(); }
  catch { if (round === active && !$('game').hidden) { $('next').hidden = false; status('Preview could not play. Try replaying, or move to another song.'); } }
}
function submit(guess) {
  const outcome = round.submit(guess);
  if (outcome !== 'longer' || guess) player.stop();
  if (outcome === 'correct') { wins++; points += lengths.length - round.step; }
  render();
  status(outcome === 'correct' ? 'You got it!' : outcome === 'finished' ? 'That was the last clip. Here’s the song.' : `${guess ? 'Not quite.' : 'More to go on.'} Listen to ${round.seconds} seconds.`);
  if (outcome === 'longer') void play(!guess);
}
$('play').onclick = () => void play();
$('guess-form').onsubmit = event => { event.preventDefault(); const guess = $('guess').value.trim(); if (guess) submit(guess); };
$('skip').onclick = () => submit('');
$('next').onclick = nextRound;
$('change').onclick = () => { player.stop(); $('game').hidden = true; $('setup').hidden = false; status('Choose your artists for a new game.'); };
document.addEventListener('visibilitychange', () => { if (document.hidden) player.stop(); });
window.addEventListener('pagehide', () => player.stop());
