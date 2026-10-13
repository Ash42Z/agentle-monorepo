import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const presets = await import(
  pathToFileURL(`${process.cwd()}/web/songspot/presets.mjs`).href
);
const album = (id: number, title: string, record_type = "album") => ({
  id,
  title,
  record_type,
});
test("recommendations include EPs and prefer standard releases over expanded editions", () => {
  const albums = [
    album(1, "Queen II (Deluxe Edition)"),
    album(2, "Queen II (Collector’s Edition)"),
    album(3, "Queen II (2011 Remaster)"),
    album(4, "Queen II"),
    album(5, "Almost an Album", "ep"),
    album(6, "Single", "single"),
    album(7, "Live at Wembley"),
    album(8, "Greatest Hits"),
    album(9, "Songs (Expanded)"),
    album(10, "Rarities"),
    album(11, "Songs (Bonus Edition)"),
    album(12, "Songs (Anniversary Edition)"),
    album(13, "Songs (Remixes)"),
    album(14, "Songs (Rough Mixes)"),
  ];
  assert.deepEqual([...presets.defaultAlbums(albums)], [4, 5]);
  assert.deepEqual(
    [...presets.defaultAlbums([...albums].reverse())].sort(),
    [4, 5],
  );
});
test("artist presets and named artist playlists survive storage round trips, including empty presets", () => {
  let raw: string | null = null;
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  };
  assert.deepEqual(presets.readLibrary(storage), {
    version: 1,
    artists: {},
    playlists: [],
  });
  const library = {
    version: 1,
    artists: { "412": [4, 5], "7": [] },
    playlists: [{ name: "Favorites", artists: [{ id: 412, name: "Queen" }] }],
  };
  presets.writeLibrary(storage, library);
  assert.deepEqual(presets.readLibrary(storage), library);
});
test("stored data is validated and storage failures are surfaced to the caller", () => {
  const raw = {
    version: 1,
    artists: { "412": [1, 1, -2, "3"], invalid: [5] },
    playlists: [
      {
        name: "Test",
        artists: [
          { id: 412, name: "Queen" },
          { id: "412", name: "Bad" },
          { id: 7 },
        ],
      },
      { name: "", artists: [] },
    ],
  };
  assert.deepEqual(
    presets.readLibrary({ getItem: () => JSON.stringify(raw) }),
    {
      version: 1,
      artists: { "412": [1] },
      playlists: [{ name: "Test", artists: [{ id: 412, name: "Queen" }] }],
    },
  );
  assert.throws(() => presets.readLibrary({ getItem: () => "{bad" }));
  assert.throws(() => presets.readLibrary({ getItem: () => '{"version":2}' }));
  assert.throws(() =>
    presets.writeLibrary(
      {
        setItem: () => {
          throw Error("quota");
        },
      },
      {},
    ),
  );
});
