import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { composerHeight, DEFAULT_FILE_MAX_BYTES, formatBytes, oversize, pastedImage } from './chat';

describe('размер файла словами', () => {
  it('КиБ, МиБ и ГиБ без лишних нулей', () => {
    expect(formatBytes(t, 1)).toBe('1 КиБ');
    expect(formatBytes(t, 1536)).toBe('2 КиБ');
    expect(formatBytes(t, 100 * 1024 * 1024)).toBe('100 МиБ');
    expect(formatBytes(t, 1.25 * 1024 * 1024)).toBe('1,3 МиБ');
    expect(formatBytes(t, 3 * 1024 ** 3)).toBe('3 ГиБ');
  });
});

describe('предел вложения (T02)', () => {
  it('файл в пределе проходит молча', () => {
    expect(
      oversize(t, { name: 'план.pdf', size: DEFAULT_FILE_MAX_BYTES }, DEFAULT_FILE_MAX_BYTES),
    ).toBeNull();
  });

  it('больше предела — отказ с именем, размером и пределом, в момент выбора', () => {
    expect(oversize(t, { name: 'фильм.mkv', size: 1.5 * 1024 ** 3 }, DEFAULT_FILE_MAX_BYTES)).toBe(
      '«фильм.mkv» — 1,5 ГиБ. Во встречу можно отправить файл до 100 МиБ.',
    );
  });

  it('предел — тот, что назвал сервер', () => {
    expect(oversize(t, { name: 'a.zip', size: 30 * 1024 * 1024 }, 20 * 1024 * 1024)).toContain('до 20 МиБ');
  });
});

describe('высота поля сообщения (T02)', () => {
  const line = 20;
  const padding = 20;

  it('пустое и однострочное поле — одна строка, вровень с кнопками', () => {
    expect(composerHeight(0, line, padding)).toEqual({ height: 40, scrolls: false });
    expect(composerHeight(40, line, padding)).toEqual({ height: 40, scrolls: false });
  });

  it('растёт по строкам до шести', () => {
    expect(composerHeight(80, line, padding).height).toBe(80);
    expect(composerHeight(140, line, padding)).toEqual({ height: 140, scrolls: false });
  });

  it('дальше шести строк — прокрутка внутри поля', () => {
    expect(composerHeight(400, line, padding)).toEqual({ height: 140, scrolls: true });
  });
});

describe('Ctrl+V скриншота (R94)', () => {
  const clipboard = (files: File[], text = '', items: DataTransferItem[] = []) =>
    ({
      files: files as unknown as FileList,
      items: items as unknown as DataTransferItemList,
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    }) as Pick<DataTransfer, 'files' | 'items' | 'getData'>;
  const at = new Date(2026, 9, 24, 23, 15, 2);

  it('скриншот без имени получает имя по времени снимка', () => {
    const file = pastedImage(clipboard([new File(['x'], 'image.png', { type: 'image/png' })]), at)!;
    expect(file.name).toBe('screenshot-2026-10-24-231502.png');
    expect(file.type).toBe('image/png');
  });

  it('картинка из пунктов буфера, когда списка файлов нет', () => {
    const shot = new File(['x'], '', { type: 'image/jpeg' });
    const item = { kind: 'file', type: 'image/jpeg', getAsFile: () => shot } as unknown as DataTransferItem;
    expect(pastedImage(clipboard([], '', [item]), at)!.name).toBe('screenshot-2026-10-24-231502.jpg');
  });

  it('своё имя файла остаётся; текст и пустой буфер — обычная вставка', () => {
    const named = new File(['x'], 'схема.png', { type: 'image/png' });
    expect(pastedImage(clipboard([named]))).toBe(named);
    expect(pastedImage(clipboard([named], 'подпись к картинке'))).toBeNull();
    expect(pastedImage(clipboard([new File(['x'], 'a.txt', { type: 'text/plain' })]))).toBeNull();
    expect(pastedImage(clipboard([]))).toBeNull();
    expect(pastedImage(null)).toBeNull();
  });
});
