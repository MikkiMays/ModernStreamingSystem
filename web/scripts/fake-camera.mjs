// Спокойная «камера» для снимков: силуэт человека на тёплом фоне вместо зелёной таблицы
// Chromium. Пишет Y4M (YUV 4:2:0), который Chromium берёт флагом
// `--use-file-for-fake-video-capture`. Кадров мало, ролик крутится по кругу.
//
//   node scripts/fake-camera.mjs /tmp/cord-camera.y4m
import { createWriteStream } from 'node:fs';

export function writeCamera(file, { width = 960, height = 540, frames = 24 } = {}) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    out.on('error', reject);
    out.on('finish', resolve);
    out.write(`YUV4MPEG2 W${width} H${height} F12:1 Ip A1:1 C420jpeg\n`);
    const y = new Uint8Array(width * height);
    const u = new Uint8Array((width / 2) * (height / 2));
    const v = new Uint8Array((width / 2) * (height / 2));
    const yuv = (r, g, b) => [
      0.299 * r + 0.587 * g + 0.114 * b,
      128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
      128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
    ];
    for (let f = 0; f < frames; f++) {
      const sway = Math.sin((f / frames) * Math.PI * 2) * width * 0.012;
      const cx = width * 0.5 + sway;
      const head = { x: cx, y: height * 0.42, rx: width * 0.085, ry: height * 0.2 };
      const body = { x: cx, y: height * 1.02, rx: width * 0.25, ry: height * 0.36 };
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          // Комната: тёплый свет слева сверху, тень справа снизу, лампа-пятно сзади.
          const t = (i / width) * 0.6 + (j / height) * 0.4;
          let r = 214 - 120 * t;
          let g = 196 - 112 * t;
          let b = 176 - 96 * t;
          const lamp = Math.exp(
            -(((i - width * 0.82) / (width * 0.12)) ** 2 + ((j - height * 0.28) / (height * 0.2)) ** 2),
          );
          r += 40 * lamp;
          g += 34 * lamp;
          b += 20 * lamp;
          const inHead = ((i - head.x) / head.rx) ** 2 + ((j - head.y) / head.ry) ** 2 < 1;
          const inBody = ((i - body.x) / body.rx) ** 2 + ((j - body.y) / body.ry) ** 2 < 1;
          if (inBody) [r, g, b] = [58 + 18 * t, 72 + 16 * t, 98 + 10 * t];
          else if (inHead) [r, g, b] = [176 - 40 * t, 132 - 30 * t, 110 - 24 * t];
          const [Y, U, V] = yuv(r, g, b);
          y[j * width + i] = Math.max(0, Math.min(255, Y));
          if (i % 2 === 0 && j % 2 === 0) {
            const k = (j / 2) * (width / 2) + i / 2;
            u[k] = Math.max(0, Math.min(255, U));
            v[k] = Math.max(0, Math.min(255, V));
          }
        }
      }
      out.write('FRAME\n');
      out.write(Buffer.from(y));
      out.write(Buffer.from(u));
      out.write(Buffer.from(v));
    }
    out.end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`)
  await writeCamera(process.argv[2] ?? '/tmp/cord-camera.y4m');
