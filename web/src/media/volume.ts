/**
 * Громкость, выставленная сразу, а не через 100 мс (T49).
 *
 * LiveKit (`RemoteAudioTrack`, livekit-client 2.22) меняет громкость не мгновенно, а плавно:
 * `gain.setTargetAtTime(volume, 0, 0.1)` — экспонента с постоянной 100 мс. Для ползунка это хорошо,
 * а для только что подключённой дорожки — нет: узел усиления рождается на 1, и музыка, которую
 * слушатель убавил до нуля, первые 100–300 мс звучит в полную силу. К тому же нулевую громкость
 * SDK при подключении пропускает вовсе (`if (this.elementVolume)` ложно для 0).
 *
 * Здесь громкость запоминается обычным `setVolume` (чтобы SDK знал её для новых элементов), а
 * усиление переставляется на месте — до того как аудиопоток отрисует первый отсчёт.
 */
export function applyVolumeNow(
  track: { setVolume(volume: number): void; gainNode?: GainNode },
  volume: number,
) {
  track.setVolume(volume);
  const gain = track.gainNode?.gain;
  if (!gain) return;
  gain.cancelScheduledValues(0);
  gain.value = volume;
}
