/** Original short, synthesized cues; no network or third-party recordings. */
export class NotificationSounds {
  private seen = new Set<string>();
  start() {
    unlockNotificationAudio();
  }
  play(kind: 'start' | 'viewer', eventId: string) {
    if (this.seen.has(eventId)) return;
    this.seen.add(eventId);
    const context = notificationContext;
    if (!context || context.state !== 'running') return;
    const notes = kind === 'start' ? [523.25, 783.99] : [659.25, 880, 1046.5];
    notes.forEach((frequency, i) => {
      const at = context.currentTime + i * 0.075;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.06, at + 0.009);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.14);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    });
  }
  dispose() {
    this.seen.clear();
  }
}

let listening = false;
let notificationContext: AudioContext | undefined;
/** Install at application startup so the entrance gesture unlocks room cues too. */
export function unlockNotificationAudio() {
  if (listening || typeof AudioContext === 'undefined') return;
  listening = true;
  const unlock = () => {
    notificationContext ??= new AudioContext();
    void notificationContext.resume().catch(() => {});
  };
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);
}
