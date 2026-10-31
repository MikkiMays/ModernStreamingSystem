/**
 * Холст и шрифты для тестов доски (R159): jsdom не умеет `getContext('2d')`, `Path2D`, `FontFace` и
 * `document.fonts`, а Excalidraw трогает их уже при загрузке модуля. Подключать **раньше** Excalidraw —
 * первым импортом теста. Рисовать здесь нечего: тесты доски проверяют интерфейс, а не пиксели.
 */
function stub(): unknown {
  const target = function () {};
  return new Proxy(target, {
    get: (_, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === 'measureText')
        return (text: string) => ({
          width: String(text).length * 8,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
          fontBoundingBoxAscent: 10,
          fontBoundingBoxDescent: 2,
        });
      if (key === 'getImageData' || key === 'createImageData')
        return (_x: number, _y: number, w = 1, h = 1) => ({
          data: new Uint8ClampedArray(4 * w * h),
          width: w,
          height: h,
        });
      if (key === 'getLineDash') return () => [];
      if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return stub();
    },
    apply: () => stub(),
    construct: () => stub() as object,
    has: () => true,
    set: () => true,
  });
}

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return stub() as RenderingContext;
  } as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
    callback(new Blob([], { type: 'image/png' }));
  };
}

const scope = globalThis as unknown as Record<string, unknown>;
if (!scope.Path2D)
  scope.Path2D = class {
    addPath() {}
    moveTo() {}
    lineTo() {}
    closePath() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    rect() {}
  };
if (!scope.FontFace)
  scope.FontFace = class {
    status = 'loaded';
    constructor(
      readonly family: string,
      readonly source: string,
      readonly descriptors: Record<string, string> = {},
    ) {}
    load() {
      return Promise.resolve(this);
    }
  };
if (!('fonts' in document))
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add() {},
      delete() {},
      has: () => false,
      check: () => true,
      load: () => Promise.resolve([]),
      ready: Promise.resolve(),
      status: 'loaded',
      addEventListener() {},
      removeEventListener() {},
      forEach() {},
      [Symbol.iterator]: function* () {},
    },
  });
if (!scope.ResizeObserver)
  scope.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
if (typeof window.matchMedia !== 'function')
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
