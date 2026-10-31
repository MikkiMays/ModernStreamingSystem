import { useServerLoad } from '../../core/server-load';
import { LoadBars } from '../kit/LoadBars';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plug } from 'lucide-react';
import { notifyDesktop, isDesktop } from '../../core/desktop';
import { currentServerUrl, rememberServer, serverLabel, thisServer } from '../../core/servers';
import { session } from '../../core/session';
import { useStore } from '../primitives';
import { Button, Switch } from '../kit';
import { ServerMenu } from '../ServerMenu';
import { SettingGroup, SettingRow } from './Row';
import { rowText } from './sections';

/**
 * С каким сервером говорит этот клиент — другой вопрос, чем «кто вы на нём», поэтому не в
 * «Профиле». Настройки общие для всех серверов (R146, Р-39): имя, язык, устройства, звук,
 * сочетания, качество — с человеком и при смене сервера; комнаты, избранное и недавние у каждого
 * сервера свои — это и сказано под заголовком. Адреса руками здесь нет и не будет (П4).
 *
 * В приложении список серверов — родной (`servers.open`), и там же выбор, подключаться ли само при
 * запуске. В браузере сервер — это сайт: «Сменить сервер» показывает серверы из каталога установки
 * и переходит на сайт выбранного (R136), а подключение к своему серверу всегда само (R135) —
 * ни выключателя, ни «Отключиться», после которого страница тут же подключилась бы снова.
 */
export function ServerSection({
  showPing,
  changePing,
  inCall,
}: {
  showPing: boolean;
  changePing: (showPing: boolean) => void;
  inCall: boolean;
}) {
  const { t } = useTranslation();
  const desktop = isDesktop();
  const current = useStore(session);
  const [saved, setSaved] = useState(thisServer);
  const load = useServerLoad();
  return (
    <SettingGroup title={t(($) => $.settings.server.connection)} note={t(($) => $.settings.server.shared)}>
      <SettingRow
        id="server-current"
        hint={
          <>
            {`${current?.name || serverLabel(saved)} · ${new URL(currentServerUrl()).host}`}
            {/* Загрузка этого сервера словами и палочками (R143). */}
            {load && (
              <>
                {' · '}
                <LoadBars level={load.level} state={load.state} withText />
              </>
            )}
          </>
        }
      >
        {desktop ? (
          <Button
            size="sm"
            icon={<Plug />}
            disabled={inCall}
            title={inCall ? t(($) => $.settings.server.leaveFirst) : undefined}
            onClick={() => notifyDesktop('servers.open')}
          >
            {t(($) => $.settings.server.change)}
          </Button>
        ) : (
          <ServerMenu
            label={t(($) => $.settings.server.change)}
            icon={<Plug />}
            disabled={inCall}
            title={inCall ? t(($) => $.settings.server.leaveFirst) : undefined}
          />
        )}
      </SettingRow>
      {desktop && (
        <SettingRow id="server-autoconnect">
          <Switch
            checked={saved.autoConnect}
            ariaLabel={rowText(t, 'server-autoconnect').label}
            onCheckedChange={(autoConnect) => {
              setSaved(rememberServer({ autoConnect }));
              // Список адресов — родной, и выключатель правдив, только если оболочка о нём узнала;
              // иначе это флажок, который ничего не делает.
              notifyDesktop('server.autoconnect', { autoConnect });
            }}
          />
        </SettingRow>
      )}
      {!!saved.password && (
        <SettingRow id="server-password">
          <Button size="sm" variant="quiet" onClick={() => setSaved(rememberServer({ password: '' }))}>
            {t(($) => $.settings.server.forget)}
          </Button>
        </SettingRow>
      )}
      <SettingRow id="server-ping">
        <Switch checked={showPing} ariaLabel={rowText(t, 'server-ping').label} onCheckedChange={changePing} />
      </SettingRow>
    </SettingGroup>
  );
}
