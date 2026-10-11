export const lengths = [0.5, 2, 8, 15];
export function normalize(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
export function playableTracks(tracks) {
  const seen = new Set();
  return tracks.filter(track => {
    const key = `${track.artist?.id}:${normalize(track.title || '')}`;
    if (!track.id || !track.title || !track.artist?.name || !/^https:\/\//.test(track.preview || '') || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export class Round {
  constructor(track) { this.track = track; this.step = 0; this.done = false; this.won = false; }
  get seconds() { return lengths[this.step]; }
  submit(guess) {
    if (this.done) return 'finished';
    if (guess && [this.track.title, this.track.title_short].some(title => title && normalize(guess) === normalize(title))) {
      this.done = this.won = true; return 'correct';
    }
    if (this.step === lengths.length - 1) { this.done = true; return 'finished'; }
    this.step++; return 'longer';
  }
}
// One audio source, one timer: every replay starts at the same point in the preview.
export class ClipPlayer {
  constructor(audio, schedule = (callback, delay) => setTimeout(callback, delay), cancel = timer => clearTimeout(timer)) {
    this.audio = audio; this.schedule = schedule; this.cancel = cancel; this.version = 0;
  }
  stop() { this.version++; this.cancel(this.timer); this.audio.pause(); }
  async play(url, seconds) {
    this.stop();
    const version = this.version;
    if (this.audio.src !== url) this.audio.src = url;
    this.audio.currentTime = 0;
    await this.audio.play();
    if (version !== this.version) return;
    this.timer = this.schedule(() => this.stop(), seconds * 1000);
  }
}
