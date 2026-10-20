/**
 * Даст ли WebView Telegram микрофон — до входа во встречу (спецификация E09 §6).
 *
 * Встроенные браузеры Telegram разные: iOS (WKWebView) спрашивает разрешение каждый сеанс, Android —
 * своим окном на каждый запрос, Web — разрешением браузера для домена Cord, а старые клиенты
 * `mediaDevices` не дают вовсе. Камеру здесь не трогаем: она во встрече выключена, и лишний запрос на
 * Android — лишнее окно. Отказ — не тупик: экран предлагает браузер или вход без микрофона.
 */
export type MicrophoneProbe = 'ok' | 'denied' | 'unsupported';

export async function probeMicrophone(
  media: Pick<MediaDevices, 'getUserMedia'> | undefined = navigator.mediaDevices,
): Promise<MicrophoneProbe> {
  if (typeof media?.getUserMedia !== 'function') return 'unsupported';
  try {
    const stream = await media.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return 'ok';
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unsupported';
  }
}
