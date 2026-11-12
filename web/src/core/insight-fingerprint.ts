import { sha256 } from './proof-solve';

/**
 * Признаки отпечатка устройства для аналитики (R239, `docs/architecture/analytics-v2.md` §4.3,
 * `contracts/insight.md` §1.1).
 *
 * Зачем: узнать вернувшегося человека, у которого нет ни куки сервера, ни профиля (инкогнито, очистка
 * данных, другой домен). Сервер сводит признаки в один необратимый отпечаток и хранит только его.
 *
 * Наружу уходят хэши, а не сырьё: ни картинки canvas, ни списка шрифтов в событии нет. Исключение —
 * строка модели видеокарты: по ней сервер отличает настоящий экран от программной отрисовки роботов.
 *
 * Любой признак может не получиться (старый движок, запрет политики, тесты без canvas) — тогда его
 * просто нет; исключений модуль не бросает и страницу не задерживает дольше `AUDIO_TIMEOUT`.
 */
export interface Fingerprint {
  canvas?: string;
  gl?: string;
  glr?: string;
  fonts?: string;
  audio?: string;
  hc?: number;
  dm?: number;
  touch?: number;
  plat?: string;
}

const AUDIO_TIMEOUT = 800;
const HASH = 32;
/** Шрифты разных систем: какие из них стоят — различает Windows, macOS, Linux, Android и офисные пакеты. */
const FONTS = [
  'Arial',
  'Calibri',
  'Cambria',
  'Candara',
  'Consolas',
  'Corbel',
  'Segoe UI',
  'Tahoma',
  'Verdana',
  'Trebuchet MS',
  'Georgia',
  'Garamond',
  'Palatino',
  'Helvetica Neue',
  'Menlo',
  'Monaco',
  'San Francisco',
  'Lucida Grande',
  'Optima',
  'Futura',
  'Gill Sans',
  'DejaVu Sans',
  'Liberation Sans',
  'Ubuntu',
  'Noto Sans',
  'Roboto',
  'Droid Sans',
  'PT Sans',
  'MS Gothic',
  'SimSun',
  'Malgun Gothic',
  'Century Gothic',
  'Franklin Gothic Medium',
  'Impact',
  'Comic Sans MS',
];
const PROBE = 'mmmmmmmmmmlli Щщ 0O';

const short = (text: string) => sha256(text).slice(0, HASH);

function canvasHash(): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 60;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#f60';
  context.fillRect(100, 5, 80, 30);
  context.fillStyle = '#069';
  context.font = '15px Arial, sans-serif';
  context.fillText('Cord — связь 😀 ✈', 4, 22);
  context.fillStyle = 'rgba(102, 204, 0, 0.7)';
  context.font = 'italic 17px Georgia, serif';
  context.fillText('Cord — связь 😀 ✈', 8, 44);
  context.globalCompositeOperation = 'multiply';
  context.beginPath();
  context.arc(200, 30, 22, 0, Math.PI * 2);
  context.fillStyle = '#c0f';
  context.fill();
  const data = canvas.toDataURL();
  // Пустой холст (движок без отрисовки) у всех одинаков — это не признак.
  return data.length > 200 ? short(data) : undefined;
}

function webgl(): { gl?: string; glr?: string } {
  const canvas = document.createElement('canvas');
  const gl = (canvas.getContext('webgl') ??
    canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
  if (!gl) return {};
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor = String(gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ?? '');
  const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  const traits = [
    vendor,
    renderer,
    gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    gl.getParameter(gl.MAX_TEXTURE_SIZE),
    gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    (gl.getSupportedExtensions() ?? []).join(','),
  ].join('|');
  return { gl: short(traits), glr: renderer.slice(0, 120) || undefined };
}

function fontsHash(): string | undefined {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return undefined;
  const width = (family: string) => {
    context.font = `72px ${family}`;
    return context.measureText(PROBE).width;
  };
  const bases = ['monospace', 'sans-serif', 'serif'].map((base) => [base, width(base)] as const);
  // Шрифт стоит, если строка с ним хотя бы на одной из трёх основ шире или уже самой основы.
  const present = FONTS.filter((font) =>
    bases.some(([base, plain]) => width(`'${font}', ${base}`) !== plain),
  );
  return present.length ? short(present.join(',')) : undefined;
}

function audioHash(): Promise<string | undefined> {
  const Offline =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Offline) return Promise.resolve(undefined);
  const rendered = (async () => {
    const context = new Offline(1, 5000, 44100);
    const oscillator = context.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 10000;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -50;
    compressor.knee.value = 40;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;
    oscillator.connect(compressor);
    compressor.connect(context.destination);
    oscillator.start(0);
    const samples = (await context.startRendering()).getChannelData(0);
    let sum = 0;
    for (let i = 4500; i < samples.length; i++) sum += Math.abs(samples[i]!);
    return sum > 0 ? short(sum.toString()) : undefined;
  })();
  const late = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), AUDIO_TIMEOUT));
  return Promise.race([rendered, late]).catch(() => undefined);
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Собрать признаки. Не бросает; звуковой признак ждёт не дольше `AUDIO_TIMEOUT`. */
export async function collectFingerprint(): Promise<Fingerprint> {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return {};
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const print: Fingerprint = {
    canvas: attempt(canvasHash),
    ...(attempt(webgl) ?? {}),
    fonts: attempt(fontsHash),
    audio: await audioHash().catch(() => undefined),
    hc: navigator.hardwareConcurrency || undefined,
    dm: typeof memory === 'number' ? memory : undefined,
    touch: navigator.maxTouchPoints,
    plat: navigator.platform ? navigator.platform.slice(0, 64) : undefined,
  };
  for (const key of Object.keys(print) as (keyof Fingerprint)[])
    if (print[key] === undefined) delete print[key];
  return print;
}
