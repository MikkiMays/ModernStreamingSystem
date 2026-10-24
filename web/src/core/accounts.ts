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
 * имя, ключ в Preferences, подсказка и виды входа. Видов два (R39): по QR-коду (`device` — код
 * устройства Яндекса без встречи, токен приходит этому устройству один раз) и вставленный вручную
 * токен (`token`, с подсказкой «Где взять токен»). Каким бы путём ни пришёл токен, он хранится в
 * одном и том же месте — и при включении музыки во встрече подставляется сам. Сервис, который
 * объявлен, но ещё не подключается (Telegram до E09, П5), стоит в списке со значком «Скоро».
 *
 * Слова записи — имя, подпись поля, подсказка — в каталоге (`accounts.<id>`, E14), здесь — устройство.
 */
export type AccountInputKind = 'device' | 'token';

/** Строковые поля Preferences — только такие годятся в хранилище сохранённого входа. */
type StringPreferenceKey = {
  [K in keyof Preferences]: Preferences[K] extends string ? K : never;
}[keyof Preferences];

export interface TokenAccount {
  readonly id: 'yandex-music';
  readonly soon?: false;
  /** Ключ в Preferences, где живёт значение — тот же, что читает автоподключение службы. */
  readonly key: StringPreferenceKey;
  /** Виды входа в порядке вкладок: первый открыт сразу. */
  readonly inputs: readonly AccountInputKind[];
  readonly maxLength: number;
  /** Страница, где сервис выдаёт токен (шаги — в каталоге, `accounts.<id>.howto`). */
  readonly tokenPage?: string;
}

export interface SoonAccount {
  readonly id: 'telegram';
  readonly soon: true;
}

export type AccountSpec = TokenAccount | SoonAccount;

export const ACCOUNTS: readonly AccountSpec[] = [
  {
    id: 'yandex-music',
    key: 'yandexMusicToken',
    // QR — первым, «как в прошлом приложении»: телефон под рукой у всех, а токен руками — запасной путь.
    inputs: ['device', 'token'],
    maxLength: 1000,
    // Разрешение Яндекса для того же приложения Яндекс Музыки, что и вход по коду устройства:
    // токен из адресной строки после подтверждения подходит службе так же.
    tokenPage:
      'https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d',
  },
  // Привязка чата — E09, пока `TELEGRAM_WEBAPP_ENABLED` выключен (П5, T30).
  { id: 'telegram', soon: true },
];

/** Как сервис называется в строке. */
export function accountName(t: Translate, account: AccountSpec): string {
  return t(($) => $.accounts[account.id].name);
}

/** Подпись поля входа и заглушка. Где взять токен — раскрывашкой под полем (`accounts.<id>.howto`). */
export function tokenText(t: Translate, account: TokenAccount) {
  return {
    label: t(($) => $.accounts[account.id].label),
    placeholder: t(($) => $.accounts[account.id].placeholder),
  };
}

/** Подключён ли сервис на этом устройстве: для входа по токену — сохранён ли токен. */
export function connected(account: AccountSpec, preferences: Preferences): boolean {
  return !account.soon && preferences[account.key].trim() !== '';
}
