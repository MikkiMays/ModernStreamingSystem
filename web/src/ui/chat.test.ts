import { describe, expect, it } from 'vitest';
import { composerHeight, DEFAULT_FILE_MAX_BYTES, formatBytes, oversize } from './chat';

describe('размер файла словами', () => {
  it('КиБ, МиБ и ГиБ без лишних нулей', () => {
    expect(formatBytes(1)).toBe('1 КиБ');
    expect(formatBytes(1536)).toBe('2 КиБ');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 МиБ');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1,3 МиБ');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 ГиБ');
  });
});

describe('предел вложения (T02)', () => {
  it('файл в пределе проходит молча', () => {
    expect(oversize({ name: 'план.pdf', size: DEFAULT_FILE_MAX_BYTES }, DEFAULT_FILE_MAX_BYTES)).toBeNull();
  });

  it('больше предела — отказ с именем, размером и пределом, в момент выбора', () => {
    expect(oversize({ name: 'фильм.mkv', size: 1.5 * 1024 ** 3 }, DEFAULT_FILE_MAX_BYTES)).toBe(
      '«фильм.mkv» — 1,5 ГиБ. Во встречу можно отправить файл до 100 МиБ.',
    );
  });

  it('предел — тот, что назвал сервер', () => {
    expect(oversize({ name: 'a.zip', size: 30 * 1024 * 1024 }, 20 * 1024 * 1024)).toContain('до 20 МиБ');
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
