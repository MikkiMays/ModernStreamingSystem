// Тестовый трек: 240 с, моно 22050 Гц, 16 бит — «мелодия» из тонов, чтобы издателю было что кодировать.
import { writeFileSync } from 'node:fs';
const rate = 22050,
  seconds = 240,
  n = rate * seconds;
const pcm = Buffer.alloc(n * 2);
const notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63];
for (let i = 0; i < n; i++) {
  const t = i / rate;
  const f = notes[Math.floor(t * 2) % notes.length];
  const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t);
  const v = 0.35 * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t));
  pcm.writeInt16LE(Math.round(v * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
writeFileSync(process.argv[2], Buffer.concat([header, pcm]));
console.log('wrote', process.argv[2], (header.length + pcm.length) / 1e6, 'MB');
