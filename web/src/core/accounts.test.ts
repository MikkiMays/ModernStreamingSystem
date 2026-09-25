import { expect, it } from 'vitest';
import { ACCOUNTS } from './accounts';
import { readPreferences } from './preferences';

it('describes the Yandex Music token with the same label, key and limits it had in «Профиль»', () => {
  expect(ACCOUNTS).toHaveLength(1);
  const account = ACCOUNTS[0];
  if (!account) throw new Error('реестр аккаунтов пуст');
  expect(account).toMatchObject({
    id: 'yandex-music',
    label: 'Токен Яндекс Музыки',
    key: 'yandexMusicToken',
    input: 'token',
    placeholder: 'Сохранить токен для автоподключения',
    maxLength: 1000,
  });
  expect(account.hint).toMatch(/Яндекс Музык/);
});

it('points at a real, string-valued Preferences key', () => {
  const preferences = readPreferences();
  for (const account of ACCOUNTS) expect(typeof preferences[account.key]).toBe('string');
});
