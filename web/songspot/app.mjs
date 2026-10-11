import { Round, ClipPlayer, lengths, playableTracks, studioAlbum, studioTrack, catalog } from './game.mjs';
const $ = id => document.getElementById(id);
const selected = new Map(), cache = new Map();
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
function artistChips() {
  $('selected').replaceChildren(...Array.from(selected.values(), artist => {
    const button = document.createElement('button'); button.textContent = `${artist.name} (ID ${artist.id}) ×`;
    button.setAttribute('aria-label', `Remove ${artist.name}`);
    button.onclick = () => { selected.delete(artist.id); artistChips(); };
    return button;
  }));
  $('start').disabled = !selected.size;
}
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
        selected.set(artist.id, artist); artistChips(); status(`${artist.name} selected.`);
      }; return card;
    }));
    status(artists.length ? 'Choose an artist from the results.' : 'No artists found. Try another name.');
  } catch (error) { if (version === searchVersion) status(error.message); }
};
$('start').onclick = async () => {
  $('start').disabled = true; status('Finding playable songs…');
  const artists = [...selected.values()];
  try {
    const studioOnly = $('studio-only').checked;
    const results = [];
    // Load sequentially so larger selections do not flood the music API.
    for (const artist of artists) {
      const key = `${artist.id}:${studioOnly}`;
      if (!cache.has(key)) {
        let songs;
        if (studioOnly) {
          const albums = await catalog(api, `artists/${artist.id}/albums`);
          songs = [];
          for (const album of albums.filter(studioAlbum)) {
            const albumTracks = await catalog(api, `albums/${album.id}/tracks`);
            songs.push(...albumTracks.filter(studioTrack).filter(track => track.artist?.id === artist.id));
          }
        } else {
          songs = await catalog(api, `artists/${artist.id}/tracks`);
        }
        cache.set(key, songs);
      }
      results.push(cache.get(key));
    }
    tracks = playableTracks(results.flat());
    if (!tracks.length) throw Error('No playable previews for these artists. Please choose another artist.');
    searchVersion++; $('setup').hidden = true; $('game').hidden = false;
    deck = []; count = wins = points = 0;
    $('songs').replaceChildren(...tracks.map(track => { const option = document.createElement('option'); option.value = track.title; option.label = track.artist.name; return option; }));
    nextRound();
  } catch (error) { status(error.message); }
  finally { artistChips(); }
};
function render() {
  $('round-number').textContent = `ROUND ${count}`;
  $('score').textContent = `${wins} guessed · ${points} points`;
  $('duration').textContent = `${round.seconds} seconds · replay as often as you like`;
  $('steps').replaceChildren(...lengths.map((seconds, index) => { const li = document.createElement('li'); li.textContent = `${seconds}s`; if (index === round.step) li.className = 'active'; return li; }));
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
  player.stop();
  if (!deck.length) {
    deck = [...tracks];
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    if (deck.length > 1 && deck.at(-1).id === round?.track.id) [deck[0], deck[deck.length - 1]] = [deck.at(-1), deck[0]];
  }
  round = new Round(deck.pop()); count++; render(); status('Listen to the first half second, then take a guess.');
}
async function play() {
  const active = round;
  try { await player.play(active.track.preview, active.seconds); }
  catch { if (round === active && !$('game').hidden) { $('next').hidden = false; status('Preview could not play. Try replaying, or move to another song.'); } }
}
function submit(guess) {
  player.stop(); const outcome = round.submit(guess);
  if (outcome === 'correct') { wins++; points += lengths.length - round.step; }
  render();
  status(outcome === 'correct' ? 'You got it!' : outcome === 'finished' ? 'That was the last clip. Here’s the song.' : `${guess ? 'Not quite.' : 'More to go on.'} Listen to ${round.seconds} seconds.`);
  if (outcome === 'longer') void play();
}
$('play').onclick = () => void play();
$('guess-form').onsubmit = event => { event.preventDefault(); const guess = $('guess').value.trim(); if (guess) submit(guess); };
$('skip').onclick = () => submit('');
$('next').onclick = nextRound;
$('change').onclick = () => { player.stop(); $('game').hidden = true; $('setup').hidden = false; status('Choose your artists for a new game.'); };
document.addEventListener('visibilitychange', () => { if (document.hidden) player.stop(); });
window.addEventListener('pagehide', () => player.stop());
