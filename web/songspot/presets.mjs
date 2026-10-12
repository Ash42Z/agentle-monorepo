const expanded = /\b(deluxe|expanded|collector'?s?|anniversary|box\s*set|bonus|demo|rough mix(?:es)?|outtakes?|b[ -]?sides?|rarities)\b/i;
const other = /\b(live|remix(?:es|ed)?|compilation|greatest hits|best of|collection|anthology|karaoke|tribute|soundtrack|concert|unplugged)\b/i;
const validId = id => Number.isSafeInteger(id) && id > 0;
export function defaultAlbums(albums) {
  const chosen = new Map();
  for (const album of albums) {
    if (!validId(album.id) || !['album', 'ep'].includes(album.record_type) || other.test(album.title) || expanded.test(album.title)) continue;
    const title = album.title.replace(/\([^)]*remaster[^)]*\)|\[[^\]]*remaster[^\]]*\]|\s[-–]\s.*remaster.*/gi, '').trim().toLowerCase();
    const previous = chosen.get(title);
    if (!previous || /remaster/i.test(previous.title) && !/remaster/i.test(album.title)) chosen.set(title, album);
  }
  return new Set([...chosen.values()].map(album => album.id));
}
export function readLibrary(storage) {
  const result = { version: 1, artists: {}, playlists: [] };
  const raw = storage.getItem('songspot.library.v1');
  if (!raw) return result;
  const value = JSON.parse(raw);
  if (value.version !== 1) throw Error('Saved presets use an unsupported version.');
  for (const [id, albums] of Object.entries(value.artists || {})) {
    if (validId(Number(id)) && Array.isArray(albums)) result.artists[id] = [...new Set(albums.filter(validId))];
  }
  for (const playlist of Array.isArray(value.playlists) ? value.playlists : []) {
    if (typeof playlist.name !== 'string' || !playlist.name.trim() || !Array.isArray(playlist.artists)) continue;
    const artists = new Map();
    for (const artist of playlist.artists) {
      if (validId(artist.id) && typeof artist.name === 'string') artists.set(artist.id, { id: artist.id, name: artist.name });
    }
    result.playlists.push({ name: playlist.name, artists: [...artists.values()] });
  }
  return result;
}
export function writeLibrary(storage, library) {
  storage.setItem('songspot.library.v1', JSON.stringify(library));
}
