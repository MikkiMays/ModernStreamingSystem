import { useState } from 'react';
import { Plug } from 'lucide-react';
import { notifyDesktop } from '../../core/desktop';
import { currentServerUrl, rememberServer, serverLabel, thisServer } from '../../core/servers';
import { disconnect, session } from '../../core/session';
import { useStore } from '../primitives';
import { Button, Switch } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { row } from './sections';

/**
 * С каким сервером говорит этот клиент — другой вопрос, чем «кто вы на нём», поэтому не в
 * «Профиле». Смена сервера заканчивает визит: избранное, имя и устройства принадлежат серверу и
 * с ним не переезжают. Адреса руками здесь нет и не будет (П4): в браузере сервер один — тот,
 * что отдал страницу, а список серверов держит приложение.
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
  const desktop = !!window.chrome?.webview;
  const current = useStore(session);
  const [saved, setSaved] = useState(thisServer);
  return (
    <SettingGroup title="Подключение" collapsible={false}>
      <SettingRow
        id="server-current"
        hint={`${current?.name || serverLabel(saved)} · ${new URL(currentServerUrl()).host}`}
      >
        <Button
          size="sm"
          icon={<Plug />}
          disabled={inCall}
          title={inCall ? 'Сначала выйдите из встречи' : undefined}
          onClick={() => (desktop ? notifyDesktop('servers.open') : disconnect())}
        >
          {desktop ? 'Сменить сервер' : 'Отключиться'}
        </Button>
      </SettingRow>
      <SettingRow id="server-autoconnect">
        <Switch
          checked={saved.autoConnect}
          ariaLabel={row('server-autoconnect').label}
          onCheckedChange={(autoConnect) => {
            setSaved(rememberServer({ autoConnect }));
            // В приложении список адресов — родной, и выключатель правдив, только если оболочка
            // о нём узнала; иначе это флажок, который ничего не делает.
            notifyDesktop('server.autoconnect', { autoConnect });
          }}
        />
      </SettingRow>
      {!!saved.password && (
        <SettingRow id="server-password">
          <Button size="sm" variant="quiet" onClick={() => setSaved(rememberServer({ password: '' }))}>
            Забыть пароль
          </Button>
        </SettingRow>
      )}
      <SettingRow id="server-ping">
        <Switch checked={showPing} ariaLabel={row('server-ping').label} onCheckedChange={changePing} />
      </SettingRow>
    </SettingGroup>
  );
}
