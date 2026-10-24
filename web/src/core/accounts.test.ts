import { expect, it } from 'vitest';
import { t } from '../i18n';
import { accountName, ACCOUNTS, connected, tokenText, type TokenAccount } from './accounts';
import { readPreferences } from './preferences';

it('describes the Yandex Music token under the same key and limits it had in «Профиль»', () => {
  const account = ACCOUNTS.find((entry) => entry.id === 'yandex-music') as TokenAccount | undefined;
  if (!account) throw new Error('в реестре нет Яндекс Музыки');
  expect({ ...account, name: accountName(t, account), ...tokenText(t, account) }).toMatchObject({
    name: 'Яндекс Музыка',
    label: 'Токен Яндекс Музыки',
    key: 'yandexMusicToken',
    // R39: по QR-коду — первым, токеном — вторым; страница, где Яндекс выдаёт токен, — его же.
    inputs: ['device', 'token'],
    maxLength: 1000,
  });
  expect(new URL(account.tokenPage!).hostname).toBe('oauth.yandex.ru');
});

it('держит Telegram в списке со значком «Скоро», пока E09 не включил привязку', () => {
  expect(ACCOUNTS.map((entry) => entry.id)).toEqual(['yandex-music', 'telegram']);
  expect(ACCOUNTS.find((entry) => entry.id === 'telegram')?.soon).toBe(true);
});

it('points every connectable service at a real, string-valued Preferences key', () => {
  const preferences = readPreferences();
  for (const account of ACCOUNTS) if (!account.soon) expect(typeof preferences[account.key]).toBe('string');
});

it('считает сервис подключённым, пока сохранён непустой токен; «Скоро» не подключён никогда', () => {
  const [yandex, telegram] = ACCOUNTS;
  const preferences = readPreferences();
  expect(connected(yandex!, preferences)).toBe(false);
  expect(connected(yandex!, { ...preferences, yandexMusicToken: '  ' })).toBe(false);
  expect(connected(yandex!, { ...preferences, yandexMusicToken: 'token' })).toBe(true);
  expect(connected(telegram!, { ...preferences, yandexMusicToken: 'token' })).toBe(false);
});
