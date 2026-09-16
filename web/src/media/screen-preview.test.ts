import { describe, expect, it, vi } from 'vitest';
import { fitPreview, PreviewImages, PREVIEW_HEIGHT, PREVIEW_WIDTH } from './screen-preview';

describe('вписать кадр демонстрации в превью', () => {
  it('не растягивает вертикальный телефон и сверхширокий монитор', () => {
    expect(fitPreview(1080, 1920)).toEqual({ width: 81, height: 144 });
    expect(fitPreview(5120, 1440)).toEqual({ width: 256, height: 72 });
  });

  it('вписывает обычный экран целиком по ширине', () => {
    expect(fitPreview(2560, 1440)).toEqual({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
  });

  it('не увеличивает источник меньше превью', () => {
    expect(fitPreview(160, 90)).toEqual({ width: 160, height: 90 });
  });

  it('переживает источник без размеров: первый кадр приходит раньше метаданных', () => {
    expect(fitPreview(0, 0)).toEqual({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
  });
});

describe('ссылки на присланные кадры', () => {
  const stub = () => {
    let next = 0;
    const live = new Set<string>();
    vi.stubGlobal('URL', {
      createObjectURL: () => {
        const url = `blob:preview-${next++}`;
        live.add(url);
        return url;
      },
      revokeObjectURL: (url: string) => live.delete(url),
    });
    return live;
  };

  it('отзывает прежний кадр участника, оставляя только последний', () => {
    const live = stub();
    const images = new PreviewImages();
    const first = images.accept('alice', new Uint8Array([1]));
    const second = images.accept('alice', new Uint8Array([2]));
    expect(first).not.toBe(second);
    expect([...live]).toEqual([second]);
  });

  it('ничего не оставляет после ушедшего участника и после конца встречи', () => {
    const live = stub();
    const images = new PreviewImages();
    images.accept('alice', new Uint8Array([1]));
    images.accept('bob', new Uint8Array([2]));
    images.forget('alice');
    expect(live.size).toBe(1);
    images.clear();
    expect(live.size).toBe(0);
  });
});
