import { describe, expect, it } from 'vitest';
import {
  focusKind,
  KEY_TEXT,
  muteToggle,
  volumeAfter,
  watchKey,
  type KeyContext,
  type KeyPress,
} from './watch-keys';

/** Нажатие, как его видит `keydown`: клавиша, место на клавиатуре и модификаторы. */
function press(key: string, extra: Partial<KeyPress> = {}): KeyPress {
  const code =
    key === ' '
      ? 'Space'
      : key.length === 1
        ? `Key${key.toUpperCase()}`
        : key.startsWith('Arrow')
          ? key
          : key;
  return {
    key,
    code,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    defaultPrevented: false,
    ...extra,
  };
}

const ROOM: KeyContext = {
  live: false,
  canControl: true,
  seekable: true,
  menuOpen: false,
  dialog: false,
  place: 'page',
  focus: 'other',
  focusVisible: false,
  micHotkey: false,
  micLabel: 'Ctrl + Shift + M',
};

describe('клавиши плеера', () => {
  it('таблица: стрелки — перемотка ±10 с (с Shift ±30 с) и громкость, пробел и K — пауза, M — звук, F — экран', () => {
    expect(watchKey(press('ArrowRight'), ROOM)).toEqual({ action: { type: 'seek', deltaMs: 10_000 } });
    expect(watchKey(press('ArrowLeft'), ROOM)).toEqual({ action: { type: 'seek', deltaMs: -10_000 } });
    expect(watchKey(press('ArrowRight', { shiftKey: true }), ROOM)).toEqual({
      action: { type: 'seek', deltaMs: 30_000 },
    });
    expect(watchKey(press('ArrowLeft', { shiftKey: true }), ROOM)).toEqual({
      action: { type: 'seek', deltaMs: -30_000 },
    });
    expect(watchKey(press('ArrowUp'), ROOM)).toEqual({ action: { type: 'volume', delta: 5 } });
    expect(watchKey(press('ArrowDown'), ROOM)).toEqual({ action: { type: 'volume', delta: -5 } });
    expect(watchKey(press(' '), ROOM)).toEqual({ action: { type: 'toggle' } });
    expect(watchKey(press('k'), ROOM)).toEqual({ action: { type: 'toggle' } });
    expect(watchKey(press('m'), ROOM)).toEqual({ action: { type: 'mute' } });
    expect(watchKey(press('f'), ROOM)).toEqual({ action: { type: 'fullscreen' } });
    // Прочие клавиши — не плеера.
    expect(watchKey(press('a'), ROOM)).toBeNull();
    expect(watchKey(press('Enter'), ROOM)).toBeNull();
  });

  it('буквы — по месту на клавиатуре: в русской раскладке K — это «л», и это тоже пауза', () => {
    expect(watchKey({ ...press('k'), key: 'л' }, ROOM)).toEqual({ action: { type: 'toggle' } });
    expect(watchKey({ ...press('f'), key: 'а' }, ROOM)).toEqual({ action: { type: 'fullscreen' } });
  });

  it('пауза и перемотка общие: без права на пульт — подсказка почему, а своё (громкость, экран) можно', () => {
    const guest = { ...ROOM, canControl: false };
    expect(watchKey(press(' '), guest)).toEqual({ hint: KEY_TEXT.locked });
    expect(watchKey(press('ArrowRight'), guest)).toEqual({ hint: KEY_TEXT.locked });
    expect(watchKey(press('ArrowUp'), guest)).toEqual({ action: { type: 'volume', delta: 5 } });
    expect(watchKey(press('m'), guest)).toEqual({ action: { type: 'mute' } });
    expect(watchKey(press('f'), guest)).toEqual({ action: { type: 'fullscreen' } });
  });

  it('эфир не ставят на паузу и не перематывают — так и говорится', () => {
    const live = { ...ROOM, live: true };
    expect(watchKey(press(' '), live)).toEqual({ hint: KEY_TEXT.live });
    expect(watchKey(press('ArrowLeft'), live)).toEqual({ hint: KEY_TEXT.live });
    expect(watchKey(press('ArrowDown'), live)).toEqual({ action: { type: 'volume', delta: -5 } });
  });

  it('пока длительность неизвестна, перемотке некуда вставать — клавиша молчит', () => {
    expect(watchKey(press('ArrowRight'), { ...ROOM, seekable: false })).toBeNull();
    expect(watchKey(press(' '), { ...ROOM, seekable: false })).toEqual({ action: { type: 'toggle' } });
  });

  it('клавиша не плеера: поле ввода, фокус в другом месте экрана, диалог, открытое меню, Ctrl/Alt/Meta', () => {
    for (const context of [
      { ...ROOM, focus: 'text' as const },
      { ...ROOM, place: 'elsewhere' as const },
      { ...ROOM, dialog: true },
      { ...ROOM, menuOpen: true },
    ]) {
      expect(watchKey(press(' '), context)).toBeNull();
      expect(watchKey(press('ArrowRight'), context)).toBeNull();
    }
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey'] as const)
      expect(watchKey(press('ArrowRight', { [modifier]: true }), ROOM)).toBeNull();
    // Кто-то уже взял клавишу (стрелки полки каталога) — плеер её не трогает.
    expect(watchKey(press('ArrowRight', { defaultPrevented: true }), ROOM)).toBeNull();
  });

  it('ползунку — его стрелки, плееру — пробел; пробел на кнопке с клавиатуры — нажатие кнопки', () => {
    const slider = { ...ROOM, place: 'theater' as const, focus: 'range' as const };
    expect(watchKey(press('ArrowRight'), slider)).toBeNull();
    expect(watchKey(press('ArrowUp'), slider)).toBeNull();
    expect(watchKey(press(' '), slider)).toEqual({ action: { type: 'toggle' } });
    const button = { ...ROOM, place: 'theater' as const, focus: 'button' as const };
    expect(watchKey(press(' '), { ...button, focusVisible: true })).toBeNull();
    // Фокус остался на кнопке после нажатия мышью — пробел снова пауза, а не повтор той кнопки.
    expect(watchKey(press(' '), button)).toEqual({ action: { type: 'toggle' } });
    expect(watchKey(press('ArrowRight'), { ...button, focusVisible: true })).toEqual({
      action: { type: 'seek', deltaMs: 10_000 },
    });
  });

  it('удержание: стрелки повторяются, пауза и экран — нет', () => {
    expect(watchKey(press('ArrowRight', { repeat: true }), ROOM)).toEqual({
      action: { type: 'seek', deltaMs: 10_000 },
    });
    expect(watchKey(press(' ', { repeat: true }), ROOM)).toBeNull();
    expect(watchKey(press('f', { repeat: true }), ROOM)).toBeNull();
  });

  /*
    Сочетание микрофона назначают любым — и голым пробелом тоже (`core/hotkeys.ts`). Тогда клавиша —
    микрофона: обработчик встречи уже включает его, а плеер не гасит нажатие и только объясняет, где
    теперь пауза.
  */
  it('пробел занят микрофоном — плеер уступает и подсказывает паузу на K', () => {
    const mic = { ...ROOM, micHotkey: true, micLabel: 'Пробел' };
    expect(watchKey(press(' '), mic)).toEqual({ hint: 'Пробел включает микрофон — пауза на K', yield: true });
    expect(watchKey(press('m'), { ...mic, micLabel: 'M' })).toEqual({
      hint: 'M включает микрофон — у плеера эта клавиша не работает',
      yield: true,
    });
  });

  it('фокус: поле, ползунок, кнопка или ничего', () => {
    const field = document.createElement('input');
    const slider = Object.assign(document.createElement('input'), { type: 'range' });
    const check = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const area = document.createElement('textarea');
    const button = document.createElement('button');
    const recorder = document.createElement('button');
    recorder.setAttribute('data-hotkey-recorder', '');
    expect(focusKind(field)).toBe('text');
    expect(focusKind(area)).toBe('text');
    expect(focusKind(recorder)).toBe('text');
    expect(focusKind(slider)).toBe('range');
    expect(focusKind(check)).toBe('button');
    expect(focusKind(button)).toBe('button');
    expect(focusKind(document.body)).toBe('other');
    expect(focusKind(null)).toBe('other');
  });

  it('громкость стрелками — от 0 до 100; «без звука» помнит, какой она была', () => {
    expect(volumeAfter(98, 5)).toBe(100);
    expect(volumeAfter(3, -5)).toBe(0);
    expect(muteToggle(60, 70)).toEqual({ volume: 0, loudness: 60 });
    expect(muteToggle(0, 60)).toEqual({ volume: 60, loudness: 60 });
    // Шёпот не возвращают: не тише восьми процентов.
    expect(muteToggle(0, 2)).toEqual({ volume: 8, loudness: 2 });
  });

  it('отклик на кадре: «+10 с», «−30 с», «Громкость 60 %», «Звук выключен»', () => {
    expect(KEY_TEXT.seek(10_000)).toBe('+10 с');
    expect(KEY_TEXT.seek(-30_000)).toBe('−30 с');
    expect(KEY_TEXT.volume(60)).toBe('Громкость 60 %');
    expect(KEY_TEXT.volume(0)).toBe('Звук выключен');
  });
});
