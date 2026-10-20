import type { Translate } from '../i18n';
import type { Preferences } from './preferences';

/**
 * Реестр внешних сервисов для раздела «Аккаунты» (T33).
 *
 * «Аккаунты» в Cord — это не учётная запись (её нет и не будет), а подключённые внешние сервисы:
 * строка на сервис с состоянием и кнопкой «Подключить» / «Подключено» / «Сбросить». Раздел
 * `ui/settings/AccountsSection` перебирает записи и не меняется, когда запись добавляется.
 *
 * ЗАЧЕМ РЕЕСТР. Токен Яндекс Музыки был первым сохранённым входом Cord и жил безымянным полем в
 * «Профиле» — среди имени и аватарки, а не среди входов. Следующему сервису нужно то же место:
 * имя, ключ в Preferences, подсказка и вид входа. Пока вид входа один — вставленный вручную
 * токен; второй появится вместе со вторым сервисом, а не раньше. Сервис, который объявлен, но
 * ещё не подключается (Telegram до E09, П5), стоит в списке со значком «Скоро».
 *
 * Слова записи — имя, подпись поля, подсказка — в каталоге (`accounts.<id>`, E14), здесь — устройство.
 */
export type AccountInputKind = 'token';

/** Строковые поля Preferences — только такие годятся в хранилище сохранённого входа. */
type StringPreferenceKey = {
  [K in keyof Preferences]: Preferences[K] extends string ? K : never;
}[keyof Preferences];

export interface TokenAccount {
  readonly id: 'yandex-music';
  readonly soon?: false;
  /** Ключ в Preferences, где живёт значение — тот же, что читает автоподключение службы. */
  readonly key: StringPreferenceKey;
  readonly input: AccountInputKind;
  readonly maxLength: number;
}

export interface SoonAccount {
  readonly id: 'telegram';
  readonly soon: true;
}

export type AccountSpec = TokenAccount | SoonAccount;

export const ACCOUNTS: readonly AccountSpec[] = [
  { id: 'yandex-music', key: 'yandexMusicToken', input: 'token', maxLength: 1000 },
  // Привязка чата — E09, пока `TELEGRAM_WEBAPP_ENABLED` выключен (П5, T30).
  { id: 'telegram', soon: true },
];

/** Как сервис называется в строке. */
export function accountName(t: Translate, account: AccountSpec): string {
  return t(($) => $.accounts[account.id].name);
}

/** Подпись поля входа, заглушка и подсказка под ним. */
export function tokenText(t: Translate, account: TokenAccount) {
  return {
    label: t(($) => $.accounts[account.id].label),
    placeholder: t(($) => $.accounts[account.id].placeholder),
    hint: t(($) => $.accounts[account.id].hint),
  };
}

/** Подключён ли сервис на этом устройстве: для входа по токену — сохранён ли токен. */
export function connected(account: AccountSpec, preferences: Preferences): boolean {
  return !account.soon && preferences[account.key].trim() !== '';
}
