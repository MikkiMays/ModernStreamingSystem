import { BLUR, COMPOSITE, DOWNSAMPLE, REFINE, VERTEX } from './shaders';
import { blurDivisor, maskSize } from './budget';

/**
 * Конвейер сведения кадра с фоном на WebGL2 (R186, Р-89).
 *
 * Проходы на кадр: загрузка кадра в текстуру → (если модель считалась) уточнение маски по кадру с
 * временным сглаживанием (`REFINE`, буфер маски — половина кадра) → для размытия: уменьшение кадра
 * шагами вдвое и два прохода взвешенного гаусса (`BLUR`) → сведение на холст (`COMPOSITE`).
 *
 * Контекст делится с MediaPipe (`canvas` в настройках сегментатора): текстура маски модели живёт в этом
 * же контексте и читается без копии через процессор. Плата за это — MediaPipe оставляет после себя
 * своё состояние GL, поэтому каждый проход привязывает программу, буфер кадра, область вывода и все
 * текстуры заново, ничего не предполагая о текущем состоянии.
 */
export interface BackgroundLook {
  mode: 'blur' | 'image';
  /** Сигма гаусса в точках буфера размытия (`BLUR_SIGMA`). */
  sigma: number;
}

const MAX_TAPS = 24;
/** Сигма мягкой копии картинки фона для «оборачивания светом». */
const SOFT_SIGMA = 6;
/** Параметры уточнения маски (подобраны на стенде по снимкам R186). */
const SIGMA_S = 1.6;
const SIGMA_R = 0.09;
const EDGE_LOW = 0.3;
const EDGE_HIGH = 0.7;
/** Доля мягкого фона в цвете края человека: картинка — заметнее, размытие — чуть. */
const WRAP = { image: 0.5, blur: 0.3 } as const;

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

type Program = { program: WebGLProgram; u: (name: string) => WebGLUniformLocation | null };

/** Гаусс одной стороны, нормированный по обеим: `weights[0]` — центр. */
export function gaussian(sigma: number): { weights: Float32Array; taps: number } {
  const taps = Math.min(MAX_TAPS, Math.ceil(sigma * 2) + 1);
  const weights = new Float32Array(MAX_TAPS);
  let total = 0;
  for (let i = 0; i < taps; i++) {
    weights[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    total += i === 0 ? weights[i]! : 2 * weights[i]!;
  }
  for (let i = 0; i < taps; i++) weights[i]! /= total;
  return { weights, taps };
}

export class Pipeline {
  readonly gl: WebGL2RenderingContext;
  private readonly refine: Program;
  private readonly down: Program;
  private readonly blur: Program;
  private readonly composite: Program;
  private readonly vao: WebGLVertexArrayObject;
  private frame: WebGLTexture;
  private frameWidth = 0;
  private frameHeight = 0;
  /** Две уточнённые маски: прошлая читается, новая пишется. */
  private masks: [Target, Target] | null = null;
  private maskRead = 0;
  private hasPrev = false;
  /** Цепочка уменьшения кадра вдвое (до буфера размытия) и два буфера размытия. */
  private halves: Target[] = [];
  private blurs: [Target, Target] | null = null;
  /** Картинка фона и её мягкая копия (в размере буфера размытия). */
  private image: WebGLTexture | null = null;
  private imageWidth = 0;
  private imageHeight = 0;
  private imageSoft: Target | null = null;
  private imageSoftDirty = false;
  private look: BackgroundLook = { mode: 'blur', sigma: 3 };

  constructor(readonly canvas: OffscreenCanvas | HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('webgl2');
    this.gl = gl;
    this.refine = this.link(REFINE, [
      'u_mask',
      'u_guide',
      'u_prev',
      'u_maskTexel',
      'u_sigmaS',
      'u_sigmaR',
      'u_edge',
      'u_hasPrev',
    ]);
    this.down = this.link(DOWNSAMPLE, ['u_src']);
    this.blur = this.link(BLUR, ['u_src', 'u_mask', 'u_step', 'u_weights', 'u_taps', 'u_pass', 'u_weighted']);
    this.composite = this.link(COMPOSITE, ['u_frame', 'u_mask', 'u_bg', 'u_bgSoft', 'u_bgFit', 'u_wrap']);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('vao');
    this.vao = vao;
    this.frame = this.texture(gl.LINEAR);
  }

  setLook(look: BackgroundLook) {
    this.look = look;
  }

  /** Картинка фона (покрытием, кадр обрезает лишнее); `null` — убрать. */
  setImage(image: ImageBitmap | null) {
    const { gl } = this;
    if (this.image) gl.deleteTexture(this.image);
    this.image = null;
    if (!image) return;
    this.image = this.texture(gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, this.image);
    this.unpack();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.imageWidth = image.width;
    this.imageHeight = image.height;
    this.imageSoftDirty = true;
  }

  /** Новый источник: прошлой маски у него нет — первая уточнённая маска берётся как есть. */
  resetTemporal() {
    this.hasPrev = false;
  }

  /** Загрузить кадр в текстуру и подготовить буферы под его размер. */
  upload(frame: VideoFrame) {
    const { gl } = this;
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (width !== this.frameWidth || height !== this.frameHeight) this.resize(width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frame);
    this.unpack();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  }

  /**
   * Уточнить маску модели по загруженному кадру. `mask` — текстура MediaPipe (R32F) размером
   * `maskWidth`×`maskHeight`; она принадлежит модели и годна только до закрытия результата, поэтому
   * проход идёт здесь же, синхронно.
   */
  refineMask(mask: WebGLTexture, maskWidth: number, maskHeight: number) {
    const { gl } = this;
    if (!this.masks) return;
    const write = this.masks[1 - this.maskRead]!;
    const read = this.masks[this.maskRead]!;
    // R32F без расширения линейной фильтрации — текстура «неполная» и читается нулями; выборка
    // соседей здесь и так своя, поэтому — без фильтрации.
    gl.bindTexture(gl.TEXTURE_2D, mask);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.begin(this.refine, write);
    this.bind(0, mask, this.refine.u('u_mask'));
    this.bind(1, this.frame, this.refine.u('u_guide'));
    this.bind(2, read.texture, this.refine.u('u_prev'));
    gl.uniform2f(this.refine.u('u_maskTexel'), 1 / maskWidth, 1 / maskHeight);
    gl.uniform1f(this.refine.u('u_sigmaS'), SIGMA_S);
    gl.uniform1f(this.refine.u('u_sigmaR'), SIGMA_R);
    gl.uniform2f(this.refine.u('u_edge'), EDGE_LOW, EDGE_HIGH);
    gl.uniform1f(this.refine.u('u_hasPrev'), this.hasPrev ? 1 : 0);
    this.draw();
    this.maskRead = 1 - this.maskRead;
    this.hasPrev = true;
  }

  /** Есть ли уже хоть одна маска — до неё кадр уходит как есть. */
  get ready(): boolean {
    return this.hasPrev;
  }

  /** Свести загруженный кадр с фоном на холст. */
  render() {
    const { gl } = this;
    if (!this.masks || !this.blurs) return;
    const mask = this.masks[this.maskRead]!.texture;
    let bg: WebGLTexture;
    let soft: WebGLTexture;
    let fit: [number, number] = [1, 1];
    if (this.look.mode === 'image' && this.image) {
      if (this.imageSoftDirty) this.softenImage();
      bg = this.image;
      soft = this.imageSoft!.texture;
      fit = this.coverFit();
    } else {
      bg = this.blurBackground(mask);
      soft = bg;
    }
    this.begin(this.composite, null);
    this.bind(0, this.frame, this.composite.u('u_frame'));
    this.bind(1, mask, this.composite.u('u_mask'));
    this.bind(2, bg, this.composite.u('u_bg'));
    this.bind(3, soft, this.composite.u('u_bgSoft'));
    gl.uniform2f(this.composite.u('u_bgFit'), fit[0], fit[1]);
    gl.uniform1f(this.composite.u('u_wrap'), this.look.mode === 'image' ? WRAP.image : WRAP.blur);
    this.draw(true);
  }

  dispose() {
    const { gl } = this;
    for (const p of [this.refine, this.down, this.blur, this.composite]) gl.deleteProgram(p.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.frame);
    if (this.image) gl.deleteTexture(this.image);
    this.release();
  }

  // --- внутреннее -----------------------------------------------------------------------------

  /** Масштаб координат картинки под покрытие кадра: лишнее по ширине или высоте обрезается. */
  private coverFit(): [number, number] {
    const frameAspect = this.frameWidth / this.frameHeight;
    const imageAspect = this.imageWidth / this.imageHeight;
    return imageAspect > frameAspect ? [frameAspect / imageAspect, 1] : [1, imageAspect / frameAspect];
  }

  /** Размытый фон: кадр, уменьшенный шагами вдвое, затем два взвешенных прохода. */
  private blurBackground(mask: WebGLTexture): WebGLTexture {
    let source = this.frame;
    for (const half of this.halves) {
      this.begin(this.down, half);
      this.bind(0, source, this.down.u('u_src'));
      this.draw();
      source = half.texture;
    }
    const [a, b] = this.blurs!;
    const { weights, taps } = gaussian(this.look.sigma);
    this.blurPass(source, mask, a, [1 / a.width, 0], weights, taps, 0, 1);
    this.blurPass(a.texture, mask, b, [0, 1 / a.height], weights, taps, 1, 1);
    return b.texture;
  }

  /** Мягкая копия картинки фона — один раз после смены картинки или размера кадра. */
  private softenImage() {
    if (!this.image || !this.imageSoft || !this.blurs) return;
    const { weights, taps } = gaussian(SOFT_SIGMA);
    const tmp = this.blurs[0]!;
    this.blurPass(this.image, this.image, tmp, [1 / tmp.width, 0], weights, taps, 0, 0);
    this.blurPass(tmp.texture, this.image, this.imageSoft, [0, 1 / tmp.height], weights, taps, 1, 0);
    this.imageSoftDirty = false;
  }

  private blurPass(
    source: WebGLTexture,
    mask: WebGLTexture,
    target: Target,
    step: [number, number],
    weights: Float32Array,
    taps: number,
    pass: 0 | 1,
    weighted: 0 | 1,
  ) {
    const { gl } = this;
    this.begin(this.blur, target);
    this.bind(0, source, this.blur.u('u_src'));
    this.bind(1, mask, this.blur.u('u_mask'));
    gl.uniform2f(this.blur.u('u_step'), step[0], step[1]);
    gl.uniform1fv(this.blur.u('u_weights'), weights);
    gl.uniform1i(this.blur.u('u_taps'), taps);
    gl.uniform1f(this.blur.u('u_pass'), pass);
    gl.uniform1f(this.blur.u('u_weighted'), weighted);
    this.draw();
  }

  private resize(width: number, height: number) {
    this.release();
    this.frameWidth = width;
    this.frameHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
    const m = maskSize(width, height);
    this.masks = [this.target(m.width, m.height), this.target(m.width, m.height)];
    this.hasPrev = false;
    this.halves = [];
    let w = width;
    let h = height;
    for (let d = blurDivisor(width); d > 1; d /= 2) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      this.halves.push(this.target(w, h));
    }
    this.blurs = [this.target(w, h), this.target(w, h)];
    this.imageSoft = this.target(w, h);
    this.imageSoftDirty = true;
  }

  private release() {
    const { gl } = this;
    for (const t of [...(this.masks ?? []), ...this.halves, ...(this.blurs ?? []), this.imageSoft]) {
      if (!t) continue;
      gl.deleteFramebuffer(t.framebuffer);
      gl.deleteTexture(t.texture);
    }
    this.masks = null;
    this.halves = [];
    this.blurs = null;
    this.imageSoft = null;
  }

  private unpack() {
    const { gl } = this;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  private texture(filter: number): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture();
    if (!texture) throw new Error('texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private target(width: number, height: number): Target {
    const { gl } = this;
    const texture = this.texture(gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error('framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height };
  }

  /** Полная привязка прохода: программа, буфер вывода, область, состояние — MediaPipe их меняет. */
  private begin(program: Program, target: Target | null) {
    const { gl } = this;
    gl.useProgram(program.program);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, target?.width ?? this.frameWidth, target?.height ?? this.frameHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.uniform1f(program.u('u_flip'), target ? 0 : 1);
  }

  private bind(unit: number, texture: WebGLTexture, location: WebGLUniformLocation | null) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }

  private draw(toCanvas = false) {
    const { gl } = this;
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (toCanvas) gl.flush();
  }

  private link(fragment: string, names: string[]): Program {
    const { gl } = this;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(`shader: ${gl.getShaderInfoLog(shader) ?? ''}`);
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new Error('program');
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`program: ${gl.getProgramInfoLog(program) ?? ''}`);
    const uniforms = new Map<string, WebGLUniformLocation | null>();
    for (const name of [...names, 'u_flip']) uniforms.set(name, gl.getUniformLocation(program, name));
    return { program, u: (name) => uniforms.get(name) ?? null };
  }
}
