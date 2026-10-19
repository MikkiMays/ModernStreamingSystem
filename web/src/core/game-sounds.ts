import type { ChessTable, GameVisualEvent, GarticTable } from '../api/types';
import { readPreferences, type GameKind } from './preferences';
import { ensureNotificationAudio, notificationAudio, soundVolume } from './sounds';

/**
 * Звуки столов (T45).
 *
 * ЗВУК — ОТ ТОГО ЖЕ СОБЫТИЯ, ЧТО И АНИМАЦИЯ. Сервер кладёт в снимок публичные события движения
 * карт (`visualEvents`), ходы шахмат и догадки Gartic; анимация и звук читают одно и то же, поэтому
 * карта шлёпается о сукно у всех в один момент, а открывший вкладку посреди раздачи не слышит
 * двадцать четыре шлепка подряд: первый снимок и восстановление после обрыва только ставят курсор.
 *
 * Карты и фишки — записи Kenney «Casino Audio» (CC0, `infra/THIRD-PARTY-AUDIO.txt`), шахматы и
 * Gartic — свой синтез, как сигналы встречи. Запись не декодировалась (старый Safari не знает OGG) —
 * вместо неё звучит синтез того же характера: игра без звука хуже, чем со звуком попроще.
 */
export type GameSound =
  | 'shuffle'
  | 'deal'
  | 'place'
  | 'slide'
  | 'sweep'
  | 'discard'
  | 'chip'
  | 'chips'
  | 'collect'
  | 'move'
  | 'capture'
  | 'check'
  | 'mate'
  | 'tick'
  | 'round'
  | 'correct'
  | 'win'
  | 'lose';

export interface Cue {
  sound: GameSound;
  /** Сдвиг от «сейчас», мс: раздача звучит по одной карте, как и летит. */
  delay: number;
}

/** Записи по звукам; из нескольких берётся следующая по кругу, чтобы повтор не резал слух. */
const SAMPLES: Partial<Record<GameSound, string[]>> = {
  shuffle: ['card-shuffle'],
  deal: ['card-slide-1', 'card-slide-2'],
  slide: ['card-slide-2', 'card-slide-1'],
  place: ['card-place-1', 'card-place-2'],
  sweep: ['card-shove-1'],
  discard: ['cards-pack-take-out-1'],
  chip: ['chip-lay-1', 'chip-lay-2'],
  chips: ['chips-stack-1'],
  collect: ['chips-handle-1'],
};

/** Шаг раздачи — тот же, что у полёта карт (`core/durak.ts` `DEAL_STEP_MS`). */
const DEAL_STEP = 70;
/** Сколько карт раздачи звучит отдельно: дальше это уже шум, а не раздача. */
const DEAL_VOICES = 6;
/** Событие старше этого — уже прошлое: так же отсекает его и `CardMotion`. */
export const RECENT_MS = 2200;

/**
 * Что прозвучит на новые события стола.
 *
 * Одно и то же событие у двух игр значит разное: `discard` у дурака — бой ушёл в отбой («бито»), у
 * покера — сброшенная рука; `draw` у дурака — добор из колоды, у покера — карта на борт.
 */
export function cardCues(game: 'poker' | 'durak', events: readonly GameVisualEvent[]): Cue[] {
  const cues: Cue[] = [];
  const deals = events.filter((event) => event.type === 'deal');
  if (deals.length) {
    cues.push({ sound: 'shuffle', delay: 0 });
    deals
      .slice(0, DEAL_VOICES)
      .forEach((_, index) => cues.push({ sound: 'deal', delay: 180 + index * DEAL_STEP }));
  }
  let draws = 0;
  for (const event of events) {
    if (event.type === 'deal') continue;
    if (event.type === 'draw') {
      if (game === 'poker') cues.push({ sound: 'place', delay: draws++ * 120 });
      else if (draws < 3) cues.push({ sound: 'deal', delay: draws++ * DEAL_STEP });
      continue;
    }
    const sound: GameSound | null =
      event.type === 'play'
        ? 'place'
        : event.type === 'transfer'
          ? 'slide'
          : event.type === 'take'
            ? 'sweep'
            : event.type === 'discard'
              ? game === 'durak'
                ? 'discard'
                : 'slide'
              : null;
    // Закрытый бой дурака лежит на столе ещё мгновение и только потом уезжает (`durak-sweep`):
    // шорох звучит, когда карты двинулись, а не когда бой закрылся.
    const late = game === 'durak' && (sound === 'sweep' || sound === 'discard');
    if (sound) cues.push({ sound, delay: late ? SWEEP_DELAY : 0 });
  }
  return cues;
}

/** Через сколько закрытый бой дурака начинает уезжать — то же число, что `--sweep-delay`. */
const SWEEP_DELAY = 450;

/**
 * Курсор событий: первый снимок и снимок после обрыва — это состояние, а не новости.
 * Возвращает только новые, свежие события.
 */
export class EventCursor {
  private cursor: number | null = null;
  private wasConnected = true;
  take(events: readonly GameVisualEvent[], connected: boolean, now: number): GameVisualEvent[] {
    const max = events.reduce((value, event) => Math.max(value, event.id), 0);
    const baseline = this.cursor === null || !connected || !this.wasConnected || max < this.cursor;
    const previous = this.cursor ?? max;
    this.wasConnected = connected;
    this.cursor = max;
    if (baseline) return [];
    return events.filter((event) => event.id > previous && now - event.at < RECENT_MS);
  }
}

/** Ход шахмат по записи: мат, шах, взятие или просто ход. */
export function chessCue(previous: ChessTable | null, next: ChessTable): GameSound | null {
  if (!previous || previous.id !== next.id) return null;
  const last = next.moves.at(-1);
  if (last && last.ply > previous.ply) {
    if (last.san.includes('#')) return 'mate';
    if (last.san.includes('+')) return 'check';
    if (last.san.includes('x')) return 'capture';
    return 'move';
  }
  if (!previous.result && next.result) return 'round';
  return null;
}

/** Gartic: новый раунд, верная догадка, раскрытие, конец игры. */
export function garticCues(previous: GarticTable | null, next: GarticTable): GameSound[] {
  if (!previous || previous.gameId !== next.gameId) return [];
  const cues: GameSound[] = [];
  if (previous.phase !== next.phase) {
    if (next.phase === 'finished') cues.push('win');
    else if (['drawing', 'prompt', 'describing'].includes(next.phase)) cues.push('round');
    else if (next.phase === 'round-reveal' || next.phase === 'reveal') cues.push('check');
  }
  const seen = new Set(previous.guesses.map((guess) => guess.id));
  if (next.guesses.some((guess) => guess.correct && !seen.has(guess.id))) cues.push('correct');
  if (
    next.phase === 'reveal' &&
    previous.phase === 'reveal' &&
    (next.revealEntry !== previous.revealEntry || next.revealAlbum !== previous.revealAlbum)
  )
    cues.push('move');
  return cues;
}

/** Секунды, на которых тикают часы своего хода: последние пять. */
export function tickSecond(deadline: number, now: number): number | null {
  const left = Math.ceil((deadline - now) / 1000);
  return left >= 1 && left <= 5 ? left : null;
}

/** Звучать ли этой игре: общий выключатель сигналов, свой у игры и не нулевая громкость. */
export function audible(game: GameKind): boolean {
  const preferences = readPreferences();
  return preferences.notificationSounds && preferences.gameSounds[game] && preferences.soundVolume > 0;
}

// --- Проигрывание ---------------------------------------------------------------------------

const buffers = new Map<string, Promise<AudioBuffer | null>>();
const rotation = new Map<GameSound, number>();

function sample(context: AudioContext, name: string): Promise<AudioBuffer | null> {
  let loading = buffers.get(name);
  if (!loading) {
    loading = fetch(`/sounds/games/${name}.ogg`)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(name))))
      .then((data) => context.decodeAudioData(data))
      .catch(() => null);
    buffers.set(name, loading);
  }
  return loading;
}

/** Записи карт и фишек подтягиваются заранее, когда стол появился, — первый шлепок не опаздывает. */
export function preloadGameSounds(game: GameKind) {
  if (game !== 'poker' && game !== 'durak') return;
  const context = notificationAudio();
  if (!context) return;
  const wanted =
    game === 'poker'
      ? ['shuffle', 'deal', 'place', 'slide', 'chip', 'chips', 'collect']
      : ['shuffle', 'deal', 'place', 'slide', 'sweep', 'discard'];
  for (const sound of wanted)
    for (const name of SAMPLES[sound as GameSound] ?? []) void sample(context, name);
}

/** Сыграть звук стола, если этой игре сейчас можно звучать. */
export function playGameSound(game: GameKind, sound: GameSound, delay = 0) {
  if (!audible(game)) return;
  ensureNotificationAudio();
  const context = notificationAudio();
  if (!context || context.state !== 'running') return;
  const volume = soundVolume();
  const names = SAMPLES[sound];
  if (!names) {
    synth(context, sound, delay / 1000, volume);
    return;
  }
  const turn = rotation.get(sound) ?? 0;
  rotation.set(sound, turn + 1);
  const name = names[turn % names.length]!;
  const asked = context.currentTime;
  void sample(context, name).then((buffer) => {
    // Запись догрузилась позже, чем звук был нужен, — опоздавший шлепок хуже тишины.
    const late = context.currentTime - asked;
    if (late > 0.35) return;
    const at = context.currentTime + Math.max(0, delay / 1000 - late);
    if (!buffer) {
      synth(context, sound, at - context.currentTime, volume);
      return;
    }
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = 0.55 * volume;
    source.connect(gain).connect(context.destination);
    source.start(at);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
  });
}

interface Tone {
  hz: number;
  to?: number;
  at: number;
  hold: number;
  gain: number;
  type?: OscillatorType;
}
const tone = (
  hz: number,
  at: number,
  hold: number,
  gain: number,
  type: OscillatorType = 'sine',
  to?: number,
): Tone => ({
  hz,
  at,
  hold,
  gain,
  type,
  to,
});
/** Без шума — только тоны: у шахмат дерево (короткий низкий удар), у Gartic колокольчики. */
const TONES: Record<GameSound, Tone[]> = {
  move: [tone(300, 0, 0.07, 0.09, 'triangle', 140)],
  capture: [tone(320, 0, 0.06, 0.09, 'triangle', 150), tone(240, 0.07, 0.09, 0.1, 'triangle', 110)],
  check: [tone(880, 0, 0.1, 0.05, 'triangle'), tone(659.25, 0.1, 0.16, 0.05, 'triangle')],
  mate: [
    tone(783.99, 0, 0.14, 0.055),
    tone(659.25, 0.12, 0.14, 0.055),
    tone(523.25, 0.24, 0.18, 0.055),
    tone(261.63, 0.38, 0.4, 0.06, 'triangle'),
  ],
  tick: [tone(1760, 0, 0.03, 0.035, 'square')],
  round: [tone(1046.5, 0, 0.16, 0.045), tone(1567.98, 0.09, 0.24, 0.04)],
  correct: [tone(659.25, 0, 0.1, 0.05), tone(987.77, 0.07, 0.2, 0.05)],
  win: [
    tone(523.25, 0, 0.14, 0.06),
    tone(659.25, 0.06, 0.14, 0.06),
    tone(783.99, 0.12, 0.16, 0.06),
    tone(1046.5, 0.18, 0.3, 0.065),
  ],
  lose: [
    tone(659.25, 0, 0.16, 0.05, 'triangle'),
    tone(523.25, 0.14, 0.16, 0.05, 'triangle'),
    tone(440, 0.28, 0.34, 0.05, 'triangle'),
  ],
  // Замены записей, если OGG не декодируется: короткие глухие удары.
  shuffle: [
    tone(220, 0, 0.05, 0.05, 'triangle', 120),
    tone(200, 0.06, 0.05, 0.05, 'triangle', 110),
    tone(240, 0.12, 0.05, 0.05, 'triangle', 120),
  ],
  deal: [tone(260, 0, 0.04, 0.06, 'triangle', 130)],
  slide: [tone(240, 0, 0.08, 0.05, 'triangle', 100)],
  place: [tone(200, 0, 0.05, 0.08, 'triangle', 90)],
  sweep: [tone(180, 0, 0.18, 0.05, 'triangle', 80)],
  discard: [tone(160, 0, 0.12, 0.06, 'triangle', 70)],
  chip: [tone(2200, 0, 0.03, 0.03, 'square'), tone(2600, 0.04, 0.03, 0.025, 'square')],
  chips: [
    tone(2400, 0, 0.03, 0.03, 'square'),
    tone(2000, 0.035, 0.03, 0.03, 'square'),
    tone(2800, 0.07, 0.03, 0.025, 'square'),
  ],
  collect: [
    tone(2000, 0, 0.03, 0.03, 'square'),
    tone(2400, 0.05, 0.03, 0.03, 'square'),
    tone(2800, 0.1, 0.04, 0.03, 'square'),
  ],
};

function synth(context: AudioContext, sound: GameSound, offset: number, volume: number) {
  for (const { hz, to, at, hold, gain: level, type } of TONES[sound]) {
    const starts = context.currentTime + offset + at;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type ?? 'sine';
    oscillator.frequency.setValueAtTime(hz, starts);
    if (to) oscillator.frequency.exponentialRampToValueAtTime(to, starts + hold);
    gain.gain.setValueAtTime(0, starts);
    gain.gain.linearRampToValueAtTime(level * volume, starts + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, starts + hold);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(starts);
    oscillator.stop(starts + hold + 0.01);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }
}
