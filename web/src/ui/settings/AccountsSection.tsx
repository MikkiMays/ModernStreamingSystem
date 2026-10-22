import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Music, Send, type LucideIcon } from 'lucide-react';
import {
  accountName,
  ACCOUNTS,
  connected,
  tokenText,
  type AccountSpec,
  type TokenAccount,
} from '../../core/accounts';
import type { Preferences } from '../../core/preferences';
import { Badge, Button, Soon } from '../kit';
import { SettingGroup } from './Row';
import { rowDomId, type RowId } from './sections';

const ICONS: Record<string, LucideIcon> = { 'yandex-music': Music, telegram: Send };

/** Форма входа по токену: появляется под строкой по «Подключить» и уходит по «Отмена». */
function TokenForm({
  account,
  onSave,
  onCancel,
}: {
  account: TokenAccount;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const text = tokenText(t, account);
  const [value, setValue] = useState('');
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onSave(value.trim());
  };
  return (
    <form className="setting-account__form" onSubmit={submit}>
      <div className="setting-account__field">
        <label className="setting-row__label" htmlFor={`${id}-token`}>
          {text.label}
        </label>
        <input
          id={`${id}-token`}
          aria-describedby={`${id}-hint`}
          className="ui-input"
          type="password"
          autoComplete="off"
          autoFocus
          maxLength={account.maxLength}
          value={value}
          placeholder={text.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
        <span className="setting-row__hint" id={`${id}-hint`}>
          {text.hint}
        </span>
      </div>
      <div className="setting-account__actions">
        <Button size="sm" variant="primary" type="submit" disabled={!value.trim()}>
          {t(($) => $.settings.accounts.save)}
        </Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          {t(($) => $.settings.accounts.cancel)}
        </Button>
      </div>
    </form>
  );
}

function AccountRow({
  account,
  preferences,
  change,
}: {
  account: AccountSpec;
  preferences: Preferences;
  change: (patch: Partial<Preferences>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // Нажатая кнопка исчезает (форма закрылась, «Сбросить» сменилось «Подключить») — фокус
  // остаётся на строке сервиса, а не падает в начало страницы.
  const self = useRef<HTMLDivElement>(null);
  const settle = () => requestAnimationFrame(() => self.current?.focus({ preventScroll: true }));
  const Icon = ICONS[account.id] ?? Music;
  const on = connected(account, preferences);
  const name = accountName(t, account);
  const state = account.soon
    ? null
    : on
      ? t(($) => $.settings.accounts.connected)
      : t(($) => $.settings.accounts.disconnected);
  return (
    <div
      ref={self}
      tabIndex={-1}
      className="setting-row setting-account"
      id={rowDomId(`account-${account.id}` as RowId)}
      data-service={account.id}
    >
      <div className="setting-account__who">
        <span className="setting-account__icon" aria-hidden="true">
          <Icon size={18} />
        </span>
        <div className="setting-row__text">
          <span className="setting-row__label">{name}</span>
          {state && <span className="setting-row__hint">{state}</span>}
        </div>
      </div>
      <div className="setting-row__control">
        {account.soon ? (
          <Soon />
        ) : on ? (
          <>
            <Badge variant="success">{t(($) => $.settings.accounts.connected)}</Badge>
            <Button
              size="sm"
              variant="quiet"
              aria-label={t(($) => $.settings.accounts.resetLabel, { name })}
              onClick={() => {
                void change({ [account.key]: '' } as Partial<Preferences>);
                settle();
              }}
            >
              {t(($) => $.settings.accounts.reset)}
            </Button>
          </>
        ) : (
          !editing && (
            <Button
              size="sm"
              variant="primary"
              aria-label={t(($) => $.settings.accounts.connectLabel, { name })}
              onClick={() => setEditing(true)}
            >
              {t(($) => $.settings.accounts.connect)}
            </Button>
          )
        )}
      </div>
      {!account.soon && !on && editing && (
        <div className="setting-row__below">
          <TokenForm
            account={account}
            onCancel={() => {
              setEditing(false);
              settle();
            }}
            onSave={(value) => {
              void change({ [account.key]: value } as Partial<Preferences>);
              setEditing(false);
              settle();
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * «Аккаунты» (T33): подключённые внешние сервисы, по строке на сервис — значок, имя, состояние и
 * кнопка «Подключить» / «Подключено» / «Сбросить», как в списках интеграций FACEIT и Discord.
 */
export function AccountsSection({
  preferences,
  change,
}: {
  preferences: Preferences;
  change: (patch: Partial<Preferences>) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <SettingGroup title={t(($) => $.settings.accounts.services)}>
      {ACCOUNTS.map((account) => (
        <AccountRow key={account.id} account={account} preferences={preferences} change={change} />
      ))}
    </SettingGroup>
  );
}
