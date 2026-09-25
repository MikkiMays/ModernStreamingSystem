import type { Preferences } from './preferences';

/**
 * Реестр сохранённых входов для вкладки «Аккаунты».
 *
 * ЗАЧЕМ РЕЕСТР РАДИ ОДНОЙ ЗАПИСИ. Токен Яндекс Музыки был первым сохранённым входом Cord, и
 * жил он безымянным полем в «Профиле» — среди имени и аватарки, а не среди входов. Следующему
 * входу (какой бы службой он ни был) нужно то же место: подпись, ключ в Preferences, подсказку
 * и вид поля. Реестр — это место; вкладка `ui/settings/AccountsTab` просто перебирает записи и
 * не меняется, когда запись добавляется.
 *
 * Пока вид входа один — вставленный вручную токен. Второй появится вместе со вторым входом, а
 * не раньше: гадать сейчас о форме входа, которого ещё нет, — не задача этой вкладки.
 */
export type AccountInputKind = 'token';

/** Строковые поля Preferences — только такие годятся в хранилище сохранённого входа. */
type StringPreferenceKey = {
  [K in keyof Preferences]: Preferences[K] extends string ? K : never;
}[keyof Preferences];

export interface AccountSpec {
  readonly id: string;
  readonly label: string;
  /** Ключ в Preferences, где живёт значение — тот же, что читает автоподключение службы. */
  readonly key: StringPreferenceKey;
  readonly input: AccountInputKind;
  readonly placeholder: string;
  readonly hint: string;
  readonly maxLength: number;
}

export const ACCOUNTS: readonly AccountSpec[] = [
  {
    id: 'yandex-music',
    label: 'Токен Яндекс Музыки',
    key: 'yandexMusicToken',
    input: 'token',
    placeholder: 'Сохранить токен для автоподключения',
    hint: 'Токен хранится на этом устройстве и подставляется, когда вы добавляете Яндекс Музыку во встречу.',
    maxLength: 1000,
  },
];
