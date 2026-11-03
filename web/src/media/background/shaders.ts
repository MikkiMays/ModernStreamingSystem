/**
 * Шейдеры конвейера фона (R186, Р-89). Все проходы — полноэкранный треугольник; `v_uv` — координаты
 * текстуры, (0,0) — верхний левый угол кадра, как у загруженного `texImage2D` без переворота. На холст
 * (последний проход) рисуется с переворотом по Y: у экранного буфера WebGL нулевая строка — нижняя.
 */
export const VERTEX = `#version 300 es
precision highp float;
out vec2 v_uv;
uniform float u_flip;
void main() {

  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = vec2(p.x, mix(p.y, 1.0 - p.y, u_flip));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Уточнение маски: совместный билатеральный фильтр по кадру + сглаживание во времени.
 *
 * Модель отдаёт маску 144×256: на кадре 640–1280 точек её край ступенчат и не совпадает с краем
 * волос и плеч. Так же, как у Meet, низкое разрешение лечит фильтр, которым управляет сам кадр:
 * сосед участвует в среднем тем сильнее, чем ближе он по цвету к точке (`u_sigmaR`) и по расстоянию
 * (`u_sigmaS` в точках маски). Край маски прилипает к краю цвета — к контуру человека.
 *
 * Временное сглаживание: уверенность модели у волос и у плеча дрожит от кадра к кадру на ±0.1, и без
 * него край мерцает. Доля нового значения `a` растёт с разницей против прошлого кадра: малые колебания
 * гасятся, настоящее движение проходит сразу (маска не отстаёт от поворота головы).
 *
 * Входы: `u_mask` — маска модели (R32F, без фильтрации), `u_guide` — кадр, `u_prev` — прежняя
 * уточнённая маска, `u_maskTexel` — 1 / размер маски модели, `u_sigmaS` — пространственная сигма в
 * точках маски, `u_sigmaR` — цветовая сигма в долях [0..1], `u_edge` — растяжение контраста (ниже x —
 * фон, выше y — человек), `u_hasPrev` — 0, если прошлого кадра нет (первый кадр, новый источник).
 */
export const REFINE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_mask;
uniform sampler2D u_guide;
uniform sampler2D u_prev;
uniform vec2 u_maskTexel;
uniform float u_sigmaS;
uniform float u_sigmaR;
uniform vec2 u_edge;
uniform float u_hasPrev;
out vec4 o_color;
const int R = 2;
void main() {
  vec3 c = texture(u_guide, v_uv).rgb;
  float sum = 0.0;
  float wsum = 0.0;
  float invS = 1.0 / (2.0 * u_sigmaS * u_sigmaS);
  float invR = 1.0 / (2.0 * u_sigmaR * u_sigmaR);
  for (int j = -R; j <= R; j++) {
    for (int i = -R; i <= R; i++) {
      vec2 d = vec2(float(i), float(j));
      vec2 p = v_uv + d * u_maskTexel;
      float m = texture(u_mask, p).r;
      vec3 g = texture(u_guide, p).rgb - c;
      float w = exp(-dot(d, d) * invS - dot(g, g) * invR);
      sum += w * m;
      wsum += w;
    }
  }
  float refined = smoothstep(u_edge.x, u_edge.y, sum / max(wsum, 1e-4));
  float prev = texture(u_prev, v_uv).r;
  float a = mix(0.3, 1.0, smoothstep(0.03, 0.25, abs(refined - prev)));
  float m = mix(refined, mix(prev, refined, a), u_hasPrev);
  o_color = vec4(m, m, m, 1.0);
}`;

/** Уменьшение вдвое: билинейная выборка в центре 2×2 — ровно среднее четырёх точек. */
export const DOWNSAMPLE = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 o_color;
void main() {
  o_color = vec4(texture(u_src, v_uv).rgb, 1.0);
}`;

/**
 * Размытие фона, взвешенное маской (нормализованная свёртка): точки человека в среднее не входят.
 *
 * Обычное гауссово размытие всего кадра размазывает цвет лица и одежды на фон — вокруг головы светлый
 * «ореол», у Meet его нет. Здесь вес отсчёта — гаусс × (1 − маска): фон у края человека продолжается
 * соседним фоном. Первый проход (`u_pass` 0, по горизонтали) пишет в альфу накопленный вес —
 * «сколько фона видно» — и второй проход (по вертикали) взвешивает уже им; где фона нет совсем
 * (середина лица), результат — обычное среднее, его закроет человек при сведении (нормировка по
 * видимому фону, без деления на ноль). `u_weighted` 0 — обычный гаусс (для мягкой копии картинки фона).
 *
 * Входы: `u_step` — шаг отсчёта, (texel, 0) или (0, texel); `u_weights` — гаусс одной стороны, [0] —
 * центр; `u_taps` — сколько отсчётов с одной стороны, включая центр; `u_pass` — 0 первый проход (вес
 * из маски), 1 второй (вес из альфы).
 */
export const BLUR = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform vec2 u_step;
uniform float u_weights[24];
uniform int u_taps;
uniform float u_pass;
uniform float u_weighted;
out vec4 o_color;
float coverage(vec2 p, vec4 s) {
  float fromMask = 1.0 - texture(u_mask, p).r;
  return mix(1.0, mix(fromMask, s.a, u_pass), u_weighted);
}
void main() {
  vec4 center = texture(u_src, v_uv);
  float cw = u_weights[0] * coverage(v_uv, center);
  vec3 sum = center.rgb * cw;
  vec3 plain = center.rgb * u_weights[0];
  float wsum = cw;
  for (int i = 1; i < 24; i++) {
    if (i >= u_taps) break;
    vec2 o = u_step * float(i);
    vec4 a = texture(u_src, v_uv + o);
    vec4 b = texture(u_src, v_uv - o);
    float wa = u_weights[i] * coverage(v_uv + o, a);
    float wb = u_weights[i] * coverage(v_uv - o, b);
    sum += a.rgb * wa + b.rgb * wb;
    plain += (a.rgb + b.rgb) * u_weights[i];
    wsum += wa + wb;
  }

  float seen = clamp(wsum * 8.0, 0.0, 1.0);
  vec3 color = mix(plain, sum / max(wsum, 1e-4), seen);
  o_color = vec4(color, wsum);
}`;

/**
 * Сведение: кадр поверх фона по уточнённой маске, с «оборачиванием светом» у края.
 *
 * `u_mode` 1 — размытие (фон — взвешенно размытый кадр), 2 — картинка (`u_bg` — картинка, вписанная
 * покрытием: `u_bgFit`). Край человека в маске мягкий на 1–3 точки; в этой полосе в цвет человека
 * подмешивается мягкий цвет фона (`u_bgSoft`, доля `u_wrap`) — так свет нового фона «заходит» на
 * контур, и вырезанный человек не выглядит наклейкой (приём Meet для подмены фона). `u_bgFit` —
 * масштаб координат картинки фона вокруг центра (покрытие кадра).
 */
export const COMPOSITE = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform sampler2D u_bg;
uniform sampler2D u_bgSoft;
uniform vec2 u_bgFit;
uniform float u_wrap;
out vec4 o_color;
void main() {
  vec3 frame = texture(u_frame, v_uv).rgb;
  float m = texture(u_mask, v_uv).r;
  vec2 bgUv = (v_uv - 0.5) * u_bgFit + 0.5;
  vec3 bg = texture(u_bg, bgUv).rgb;
  vec3 soft = texture(u_bgSoft, bgUv).rgb;
  vec3 fg = mix(frame, soft, u_wrap * (1.0 - m));
  o_color = vec4(mix(bg, fg, m), 1.0);
}`;
