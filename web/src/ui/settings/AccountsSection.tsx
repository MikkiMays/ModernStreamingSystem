import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, KeyRound, Music, QrCode, Send, type LucideIcon } from 'lucide-react';
import {
  accountName,
  ACCOUNTS,
  connected,
  tokenText,
  type AccountSpec,
  type TokenAccount,
} from '../../core/accounts';
import type { Preferences } from '../../core/preferences';
import { yandexDeviceApi } from '../../core/services';
import { paint, type BrandId } from '../brands';
import { Badge, Button, Soon, Tab, TabList, TabPanel, Tabs } from '../kit';
import { YandexDeviceLogin } from '../music/YandexDeviceLogin';
import { SettingGroup } from './Row';
import { rowDomId, type RowId } from './sections';

const ICONS: Record<string, LucideIcon> = { 'yandex-music': Music, telegram: Send };
/** Цвет плашки сервиса (`brands.ts`, R33). У «Скоро» плашка серая: сервиса ещё нет. */
const BRAND: Record<string, BrandId> = { 'yandex-music': 'yandex', telegram: 'telegram' };

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
          className="ui-input"
          type="password"
          autoComplete="off"
          autoFocus
          maxLength={account.maxLength}
          value={value}
          placeholder={text.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="setting-account__actions">
        <Button size="sm" variant="primary" type="submit" disabled={!value.trim()}>
          {t(($) => $.settings.accounts.save)}
        </Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          {t(($) => $.settings.accounts.cancel)}
        </Button>
      </div>
      {account.tokenPage && <TokenHowTo page={account.tokenPage} />}
    </form>
  );
}

/**
 * «Где взять токен» (R39): владелец спросил, где найти токен и как его добавить. Три шага и ссылка на
 * страницу Яндекса — раскрывашкой под полем, чтобы не стоять стеной текста над ним.
 */
function TokenHowTo({ page }: { page: string }) {
  const { t } = useTranslation();
  return (
    <details className="setting-account__howto">
      <summary>{t(($) => $.accounts['yandex-music'].howto.title)}</summary>
      <ol>
        <li>{t(($) => $.accounts['yandex-music'].howto.signIn)}</li>
        <li>
          {t(($) => $.accounts['yandex-music'].howto.allow)}{' '}
          <a href={page} target="_blank" rel="noopener noreferrer">
            {t(($) => $.accounts['yandex-music'].howto.open)}
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        </li>
        <li>{t(($) => $.accounts['yandex-music'].howto.copy)}</li>
      </ol>
      <p>{t(($) => $.accounts['yandex-music'].howto.kept)}</p>
    </details>
  );
}

/**
 * Вход: вкладки «По QR-коду | Токеном» (R39). QR — первым: код устройства Яндекса без встречи, токен
 * приходит этому устройству один раз и ложится туда же, куда и вставленный руками.
 */
function AccountLogin({
  account,
  onSave,
  onCancel,
}: {
  account: TokenAccount;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(account.inputs[0] ?? 'token');
  if (account.inputs.length < 2) return <TokenForm account={account} onSave={onSave} onCancel={onCancel} />;
  return (
    <Tabs
      variant="segmented"
      className="setting-account__login"
      value={mode}
      onValueChange={(next) => setMode(next as typeof mode)}
    >
      <TabList aria-label={t(($) => $.accounts['yandex-music'].tabs.label)}>
        {account.inputs.map((kind) => (
          <Tab key={kind} value={kind} icon={kind === 'device' ? <QrCode /> : <KeyRound />}>
            {kind === 'device'
              ? t(($) => $.accounts['yandex-music'].tabs.device)
              : t(($) => $.accounts['yandex-music'].tabs.token)}
          </Tab>
        ))}
      </TabList>
      <TabPanel value="device" className="setting-account__panel">
        <YandexDeviceLogin
          flow={yandexDeviceApi}
          onDone={(result) => {
            if (result.token) onSave(result.token);
          }}
        />
        <div className="setting-account__actions">
          <Button size="sm" variant="quiet" onClick={onCancel}>
            {t(($) => $.settings.accounts.cancel)}
          </Button>
        </div>
      </TabPanel>
      <TabPanel value="token" className="setting-account__panel">
        <TokenForm account={account} onSave={onSave} onCancel={onCancel} />
      </TabPanel>
    </Tabs>
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
      style={account.soon || !BRAND[account.id] ? undefined : paint(BRAND[account.id]!)}
    >
      <div className="setting-account__who">
        <span className="setting-account__icon" aria-hidden="true">
          <Icon size={20} />
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
          <AccountLogin
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
