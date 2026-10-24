// Измеритель громкости в потоке звука (R63): среднеквадратичный уровень каждые 1024 отсчёта (21 мс при
// 48 кГц — то же окно, что у анализатора в `levels.ts`) уходит в порт узла. Поток звука не зависит
// ни от кадров экрана, ни от того, видно ли окно: оверлей в игре и мини-окно звонка видят, кто
// говорит, и когда Cord спрятан или накрыт игрой. Модуль грузится как файл того же origin
// (`addModule`), CSP сервера (`script-src 'self'`) его пропускает.
const WINDOW = 1024;

class CordLevelMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.count = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) this.sum += channel[i] * channel[i];
      this.count += channel.length;
    } else this.count += 128;
    if (this.count >= WINDOW) {
      const rms = Math.sqrt(this.sum / this.count);
      this.port.postMessage(Math.max(-100, 20 * Math.log10(Math.max(rms, 1e-5))));
      this.sum = 0;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('cord-level-meter', CordLevelMeter);
