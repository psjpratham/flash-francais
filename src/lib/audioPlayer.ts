import { esc, toast } from './dom';

// Adjust this if your audio folder structure differs.
const AUDIO_BASE_PATH = '/inspire-1_livre-de-l-eleve_audio/inspire-1_livre-de-l-eleve_audio';

function pisteNumbers(code: string): string[] {
  return String(code)
    .split(/[^0-9]+/)
    .filter(Boolean);
}
function pistePath(num: string): string {
  return `${AUDIO_BASE_PATH}/INSP1_LE_Piste${num.padStart(3, '0')}.mp3`;
}
function formatAudioTime(t: number): string {
  if (!isFinite(t) || isNaN(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

type AudioHolder = HTMLDivElement & { _audioEl?: HTMLAudioElement };

/**
 * Inserts an inline player right after `btnEl` for the given piste code
 * ('036' or '036-037' for multi-track documents). Only one player is open
 * at a time — opening a new one closes any other. Shared by the session
 * screen and the book reader; don't duplicate this logic elsewhere.
 */
export function playCardAudio(code: string, btnEl: HTMLElement): void {
  const existing = btnEl.nextElementSibling;
  const alreadyOpenHere = existing?.classList.contains('audio-holder');

  document.querySelectorAll<AudioHolder>('.audio-holder').forEach((h) => {
    h._audioEl?.pause();
    h.remove();
  });
  document.querySelectorAll('.chip.audio.playing').forEach((b) => b.classList.remove('playing'));

  if (alreadyOpenHere) return;

  const tracks = pisteNumbers(code);
  const holder = document.createElement('div') as AudioHolder;
  holder.className = 'audio-holder';
  const trackPicker =
    tracks.length > 1
      ? `<div class="audio-tracks">${tracks
          .map((n, i) => `<button type="button" class="audio-track-btn${i === 0 ? ' on' : ''}" data-n="${n}">Piste ${n}</button>`)
          .join('')}</div>`
      : '';
  holder.innerHTML = `
    ${trackPicker}
    <div class="audio-row">
      <button type="button" class="audio-play">▶</button>
      <div class="audio-seek"><div class="audio-seek-fill"></div><div class="audio-seek-handle"></div></div>
      <span class="audio-time">0:00 / 0:00</span>
    </div>`;
  btnEl.insertAdjacentElement('afterend', holder);
  btnEl.classList.add('playing');

  const audioEl = new Audio(pistePath(tracks[0]));
  audioEl.preload = 'auto';
  holder._audioEl = audioEl;

  const playBtn = holder.querySelector('.audio-play') as HTMLButtonElement;
  const seek = holder.querySelector('.audio-seek') as HTMLElement;
  const fill = holder.querySelector('.audio-seek-fill') as HTMLElement;
  const handle = holder.querySelector('.audio-seek-handle') as HTMLElement;
  const timeEl = holder.querySelector('.audio-time') as HTMLElement;

  function goodDuration(): number {
    return isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
  }
  function updateProgress(): void {
    const dur = goodDuration();
    const pct = dur ? (audioEl.currentTime / dur) * 100 : 0;
    fill.style.width = pct + '%';
    handle.style.left = pct + '%';
    timeEl.textContent = `${formatAudioTime(audioEl.currentTime)} / ${formatAudioTime(dur)}`;
  }

  audioEl.addEventListener('timeupdate', updateProgress);
  audioEl.addEventListener('loadedmetadata', updateProgress);
  // some MP3 encodings report duration as Infinity/NaN — force the browser to
  // compute the real duration so seeking-by-proportion actually works
  audioEl.addEventListener('durationchange', function fixDuration() {
    if (!goodDuration() && isFinite(audioEl.duration) === false) {
      audioEl.currentTime = 1e101;
      audioEl.addEventListener(
        'timeupdate',
        function resetTime() {
          audioEl.removeEventListener('timeupdate', resetTime);
          audioEl.currentTime = 0;
          updateProgress();
        },
        { once: true },
      );
    }
  });
  audioEl.addEventListener('play', () => {
    playBtn.textContent = '⏸';
    btnEl.classList.add('playing');
  });
  audioEl.addEventListener('pause', () => {
    playBtn.textContent = '▶';
    btnEl.classList.remove('playing');
  });
  audioEl.addEventListener('ended', () => {
    playBtn.textContent = '▶';
    btnEl.classList.remove('playing');
  });
  audioEl.addEventListener('error', () => {
    const codes: Record<number, string> = {
      1: 'aborted',
      2: 'network error',
      3: 'decode error (unsupported/corrupt file)',
      4: 'file not found or format not supported (404?)',
    };
    const errCode = audioEl.error ? audioEl.error.code : -1;
    holder.innerHTML = `<div class="audio-error">
      ⚠️ Couldn't load audio (${esc(codes[errCode] || 'unknown error')})<br>
      <code>${esc(audioEl.src)}</code><br>
      Try opening that URL directly in a new tab to test it.
    </div>`;
    btnEl.classList.remove('playing');
  });

  holder.querySelectorAll<HTMLButtonElement>('.audio-track-btn').forEach((tb) => {
    tb.addEventListener('click', () => {
      holder.querySelectorAll('.audio-track-btn').forEach((x) => x.classList.remove('on'));
      tb.classList.add('on');
      audioEl.pause();
      audioEl.src = pistePath(tb.dataset.n!);
      audioEl.play().catch(() => {});
    });
  });

  playBtn.addEventListener('click', () => {
    if (audioEl.paused) audioEl.play().catch(() => {});
    else audioEl.pause();
  });

  let seekDragging = false;
  function seekToClientX(clientX: number): void {
    const dur = goodDuration();
    if (!dur) return;
    const rect = seek.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audioEl.currentTime = pct * dur;
    updateProgress();
  }
  seek.addEventListener('pointerdown', (e) => {
    seekDragging = true;
    seek.setPointerCapture(e.pointerId);
    seekToClientX(e.clientX);
  });
  seek.addEventListener('pointermove', (e) => {
    if (seekDragging) seekToClientX(e.clientX);
  });
  seek.addEventListener('pointerup', () => {
    seekDragging = false;
  });
  seek.addEventListener('pointercancel', () => {
    seekDragging = false;
  });

  // scroll wheel over the player seeks ±3s — up = forward, down = back
  holder.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const dur = goodDuration();
      const delta = e.deltaY < 0 ? 3 : -3;
      let target = Math.max(0, audioEl.currentTime + delta);
      if (dur) target = Math.min(target, dur);
      audioEl.currentTime = target;
      updateProgress();
    },
    { passive: false },
  );

  audioEl.play().catch(() => toast('Could not play audio: ' + audioEl.src));
}
