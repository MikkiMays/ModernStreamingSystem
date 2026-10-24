// «Речь» для замера обрывов (R107): фразы разной длины с паузами, гласные с формантами и слогами.
//
//   node e2e/media/gen-voice.mjs /tmp/voice.wav        # 60 с, моно 48 кГц, 16 бит
//
// Почему не тон. Шумоподавление браузера считает ровный тон шумом и давит его, а Opus с DTX молчит
// только на паузах — замер должен видеть ровно то, что видит речь: начало фразы после тишины (DTX),
// слоги (огибающая 0,45…1, ни разу не ноль внутри фразы) и конец фразы. Длины фраз все разные
// (`PHRASES`), поэтому на приёме каждую фразу можно узнать по длине и сравнить: сколько срезано.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RATE = 48000;
// Фраза, пауза после неё (с). Паузы ≥ 0,4 с — DTX успевает включиться (ему нужно 200 мс тишины).
export const PHRASES = [
  [1.2, 0.6],
  [2.0, 0.9],
  [0.8, 0.45],
  [2.6, 1.2],
  [1.6, 0.7],
  [3.0, 1.5],
  [1.0, 0.5],
  [2.2, 1.0],
  [1.4, 0.8],
  [2.8, 0.6],
];
const VOWELS = [
  [730, 1090, 2440], // а
  [570, 840, 2410], // о
  [530, 1840, 2480], // э
  [270, 2290, 3010], // и
  [300, 870, 2240], // у
];

export function render(seconds = 60) {
  const n = RATE * seconds;
  const out = new Float32Array(n);
  let t0 = 0;
  let k = 0;
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  while (t0 < seconds) {
    const [len, pause] = PHRASES[k % PHRASES.length];
    k += 1;
    const start = Math.round(t0 * RATE);
    const count = Math.round(len * RATE);
    const harmonics = 28;
    const phase = new Float64Array(harmonics + 1);
    for (let i = 0; i < count && start + i < n; i++) {
      const t = i / RATE;
      // Высота голоса плавает 115…175 Гц, слоги — 4,5 в секунду, гласная меняется на каждом слоге.
      const f0 = 145 + 30 * Math.sin(2 * Math.PI * 0.7 * t + k);
      const syllable = Math.floor(t * 4.5);
      const [f1, f2, f3] = VOWELS[(syllable + k) % VOWELS.length];
      const env = 0.45 + 0.55 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4.5 * t));
      // Края фразы — 15 мс, как у настоящего слова: без щелчка и без «плавного въезда».
      const ramp = Math.min(1, t / 0.015, (len - t) / 0.015);
      let v = 0;
      for (let h = 1; h <= harmonics; h++) {
        const f = h * f0;
        if (f > 4000) break;
        phase[h] += (2 * Math.PI * f) / RATE;
        const g =
          1 / (1 + ((f - f1) / 90) ** 2) +
          0.6 / (1 + ((f - f2) / 120) ** 2) +
          0.3 / (1 + ((f - f3) / 160) ** 2);
        v += (g / Math.sqrt(h)) * Math.sin(phase[h]);
      }
      out[start + i] = 0.16 * v * env * Math.max(0, ramp);
    }
    t0 += len + pause;
  }
  // Пол шума комнаты ≈ −60 дБ: настоящий микрофон не отдаёт цифровых нулей.
  for (let i = 0; i < n; i++) out[i] += 0.002 * noise();
  return out;
}

/** Где начинаются фразы и сколько они длятся, в секундах от начала файла. */
export function schedule(seconds = 60) {
  const list = [];
  let t0 = 0;
  let k = 0;
  while (t0 < seconds) {
    const [len, pause] = PHRASES[k % PHRASES.length];
    k += 1;
    if (t0 + len <= seconds) list.push({ start: t0, len });
    t0 += len + pause;
  }
  return list;
}

/** WAV 16 бит; `channels = 2` — стерео, где речь только слева (гарнитура с пустым правым каналом, R113). */
export function wav(samples, channels = 1) {
  const pcm = Buffer.alloc(samples.length * 2 * channels);
  for (let i = 0; i < samples.length; i++)
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2 * channels);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2 * channels, 28);
  header.writeUInt16LE(2 * channels, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

//   node e2e/media/gen-voice.mjs /tmp/voice.wav               речь, моно
//   node e2e/media/gen-voice.mjs /tmp/left.wav --left-only    речь только в левом канале стерео
//   node e2e/media/gen-voice.mjs /tmp/silence.wav --silence   10 с тишины
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  const mode = process.argv[3];
  const samples = mode === '--silence' ? new Float32Array(RATE * 10) : render(60);
  writeFileSync(process.argv[2], wav(samples, mode === '--left-only' ? 2 : 1));
  console.log('wrote', process.argv[2], mode ?? '(речь 60 с)');
}
