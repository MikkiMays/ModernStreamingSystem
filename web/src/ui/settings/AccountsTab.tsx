import type { Preferences } from '../../core/preferences';
import { ACCOUNTS, type AccountSpec } from '../../core/accounts';

/**
 * Вкладка «Аккаунты»: сохранённые входы для автоподключения служб во встрече.
 *
 * Разметка та же, что раньше была у токена Яндекс Музыки в «Профиле» — подпись, поле,
 * сноска, — только данные для неё берутся из реестра `core/accounts`, а не написаны здесь
 * вручную. Следующий вход дописывается в реестр; этот компонент от него не меняется.
 */
export function AccountsTab({
  preferences,
  change,
}: {
  preferences: Preferences;
  change: (patch: Partial<Preferences>) => void;
}) {
  return (
    <>
      {ACCOUNTS.map((account) => (
        <AccountField
          key={account.id}
          account={account}
          value={preferences[account.key]}
          onChange={(value) => change({ [account.key]: value } as Partial<Preferences>)}
        />
      ))}
    </>
  );
}

function AccountField({
  account,
  value,
  onChange,
}: {
  account: AccountSpec;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label>
        {account.label}
        {account.input === 'token' && (
          <input
            type="password"
            autoComplete="off"
            maxLength={account.maxLength}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={account.placeholder}
          />
        )}
      </label>
      <p className="form-footnote">{account.hint}</p>
    </>
  );
}
