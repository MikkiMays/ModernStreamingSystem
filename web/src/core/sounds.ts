import { readPreferences } from './preferences';

/**
 * Original short, synthesized cues; no network or third-party recordings.
 *
 * The set is designed to be told apart without looking: anything about *you* is a three-note
 * figure, anything about *someone else* is two notes, and a request to be let in is a knock —
 * a repeated tap that sounds like neither. Direction carries the meaning: rising is arrival,
 * falling is departure.
 */
export type Cue =
  | 'self-join'
  | 'self-leave'
  | 'join'
  | 'leave'
  | 'knock'
  | 'screen'
  | 'viewer'
  | 'connected'
  | 'disconnected';

interface Note {
  hz: number;
  /** Offset from the start of the cue, in seconds. */
  at: number;
  hold: number;
  gain: number;
  type?: OscillatorType;
}
const G4 = 392;
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;
const A4 = 440;
const A5 = 880;
const note = (hz: number, at: number, hold = 0.13, gain = 0.06, type: OscillatorType = 'sine'): Note => ({
  hz,
  at,
  hold,
  gain,
  type,
});
const CUES: Record<Cue, Note[]> = {
  // You are in. Three notes up, slightly fuller than the cue for anyone else.
  'self-join': [note(C5, 0, 0.16, 0.07), note(E5, 0.07, 0.16, 0.07), note(G5, 0.14, 0.2, 0.07)],
  // You are out. The same figure reversed, so leaving can never be mistaken for arriving.
  'self-leave': [note(G5, 0, 0.16, 0.07), note(E5, 0.07, 0.16, 0.07), note(C5, 0.14, 0.22, 0.07)],
  // Someone arrived: two notes up, quieter, because this can happen ten times in a meeting.
  join: [note(G5, 0, 0.12, 0.05), note(C6, 0.075, 0.15, 0.05)],
  // Someone left: two notes down.
  leave: [note(E5, 0, 0.12, 0.05), note(A4, 0.075, 0.17, 0.05)],
  // Someone is waiting to be let in. A knock asks for an answer, so it is the one cue that
  // repeats its own pitch, and it is a triangle wave to stand apart from the rest.
  knock: [note(A5, 0, 0.07, 0.065, 'triangle'), note(A5, 0.12, 0.07, 0.065, 'triangle')],
  // The server, not the room: the same shape as arriving and leaving, an octave lower and
  // slower. Bigger scope reads as a bigger sound without being a different language.
  connected: [note(G4, 0, 0.2, 0.06), note(C5, 0.1, 0.26, 0.06)],
  disconnected: [note(C5, 0, 0.2, 0.06), note(G4, 0.1, 0.28, 0.06)],
  screen: [note(C5, 0), note(G5, 0.075)],
  viewer: [note(E5, 0), note(A5, 0.075), note(C6, 0.15)],
};

export class NotificationSounds {
  private seen = new Set<string>();
  private quiet = Promise.resolve();
  start() {
    unlockNotificationAudio();
  }
  /**
   * Plays a cue. An `eventId` makes it play at most once, which is what room events need: the
   * same event arrives again over replay after a reconnect.
   */
  play(cue: Cue, eventId?: string) {
    if (eventId !== undefined) {
      if (this.seen.has(eventId)) return;
      this.seen.add(eventId);
    }
    const context = notificationContext;
    if (!context || context.state !== 'running') return;
    const notes = CUES[cue];
    for (const { hz, at, hold, gain: level, type } of notes) {
      const starts = context.currentTime + at;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type ?? 'sine';
      oscillator.frequency.value = hz;
      gain.gain.setValueAtTime(0, starts);
      gain.gain.linearRampToValueAtTime(level, starts + 0.009);
      gain.gain.exponentialRampToValueAtTime(0.0001, starts + hold);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(starts);
      oscillator.stop(starts + hold + 0.01);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    }
    const ends = Math.max(...notes.map(({ at, hold }) => at + hold));
    this.quiet = new Promise((done) => setTimeout(done, ends * 1000 + 40));
  }
  /**
   * Resolves once the last cue has finished. Closing the application while a meeting is open
   * should sound like leaving and then closing, not like both at once.
   */
  settled(): Promise<void> {
    return this.quiet;
  }
  dispose() {
    this.seen.clear();
  }
}

/**
 * Cues that belong to the application rather than to a room: connecting to a server happens
 * outside any meeting, so it cannot go through a `Meeting`'s own set.
 */
const application = new NotificationSounds();
export function signal(cue: Cue) {
  if (readPreferences().notificationSounds === false) return;
  ensureNotificationAudio();
  application.play(cue);
}

let listening = false;
let notificationContext: AudioContext | undefined;
/** Install at application startup so the entrance gesture unlocks room cues too. */
export function unlockNotificationAudio() {
  if (listening || typeof AudioContext === 'undefined') return;
  listening = true;
  document.addEventListener('pointerdown', ensureNotificationAudio);
  document.addEventListener('keydown', ensureNotificationAudio);
}
/**
 * Safe to call from inside a click handler, which is the only moment a browser lets audio
 * start. Connecting to a server is such a click, so the cues are ready before the first room.
 */
export function ensureNotificationAudio() {
  if (typeof AudioContext === 'undefined') return;
  notificationContext ??= new AudioContext();
  void notificationContext.resume().catch(() => {});
}
