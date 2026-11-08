import { useServerLoad } from '../../core/server-load';
import { LoadBars } from '../kit/LoadBars';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentServerUrl, rememberServer, serverLabel, thisServer } from '../../core/servers';
import { session } from '../../core/session';
import { locale } from '../../i18n';
import { nodeProbe, type ProbeResult } from '../../media/node-probe';
import { useStore } from '../primitives';
import { Button, Switch } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { rowText } from './sections';

/**
 * С чем говорит этот клиент — другой вопрос, чем «кто вы на нём», поэтому не в «Профиле».
 *
 * Сервера здесь не выбирают (R195, владелец: «убрать возможность выбора сервера»): продукт — один адрес,
 * а встреча живёт на том медиаузле, до которого у её создателя лучший путь, — это меряет и решает система
 * (`media/node-probe.ts`). Человеку остаётся видеть, что она намерила: «Хельсинки · 12 мс, Франкфурт ·
 * 41 мс». Пароль сервера и PING — как прежде. Строки «Подключаться автоматически» нет ни в браузере
 * (R135), ни в приложении: сервер один, подключение к нему всегда само.
 */
export function ServerSection({
  showPing,
  changePing,
  /** Узел идущей встречи — первым в строке узлов; вне встречи — null. */
  mediaNode = null,
}: {
  showPing: boolean;
  changePing: (showPing: boolean) => void;
  mediaNode?: string | null;
}) {
  const { t } = useTranslation();
  const current = useStore(session);
  const [saved, setSaved] = useState(thisServer);
  const load = useServerLoad();
  const language = locale(t);
  const [probe, setProbe] = useState<ProbeResult | null>(nodeProbe.last());
  useEffect(() => {
    // Открыли настройки — замер освежается, если устарел; один узел — мерить нечего.
    if (nodeProbe.known().length <= 1) return;
    let active = true;
    void nodeProbe.refresh().then((result) => {
      if (active) setProbe(result);
    });
    return () => {
      active = false;
    };
  }, []);
  const nodes = nodeProbe.known();
  const ordered = [...nodes].sort((a, b) => Number(b.id === mediaNode) - Number(a.id === mediaNode));
  const line = ordered
    .map((node) => {
      const title = nodeProbe.title(node.id, language);
      const measure = probe?.measures.find((m) => m.node === node.id);
      if (!measure) return title;
      const ms = measure.udpOpen ? measure.udpMs : measure.tcpMs;
      return ms === null
        ? t(($) => $.settings.server.nodeClosed, { node: title })
        : t(($) => $.settings.server.nodeMs, { node: title, ms });
    })
    .join(', ');
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
      />
      {nodes.length > 0 && (
        <SettingRow id="server-node" hint={line || t(($) => $.settings.server.nodeUnknown)} />
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
