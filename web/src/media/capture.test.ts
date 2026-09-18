import { expect, it } from 'vitest';
import { ownAudioLeaks } from './capture';

const track = (settings: Record<string, unknown>) =>
  ({ getSettings: () => settings }) as unknown as MediaStreamTrack;

it('без звука утекать нечему', () => {
  expect(ownAudioLeaks(track({ displaySurface: 'monitor' }), undefined)).toBe(false);
});

it('звук вкладки не содержит нашего: там играет только она сама', () => {
  expect(ownAudioLeaks(track({ displaySurface: 'browser' }), track({ restrictOwnAudio: false }))).toBe(false);
});

it('звук всего экрана без исключения своего — это разговор в трансляции', () => {
  expect(ownAudioLeaks(track({ displaySurface: 'monitor' }), track({ restrictOwnAudio: false }))).toBe(true);
  // Поле может быть и вовсе неизвестно: подтверждения нет — значит, считаем, что утекает.
  expect(ownAudioLeaks(track({ displaySurface: 'monitor' }), track({}))).toBe(true);
});

it('исключение подтверждено самой дорожкой — жаловаться не на что', () => {
  expect(ownAudioLeaks(track({ displaySurface: 'monitor' }), track({ restrictOwnAudio: true }))).toBe(false);
});
