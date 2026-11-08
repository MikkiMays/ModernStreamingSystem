import { useNodesLoad, useServerLoad, type NodeLoad } from '../../core/server-load';
import { LoadBars } from '../kit/LoadBars';
import { Flag } from '../kit/Flag';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '../../api/types';
import type { Meeting } from '../../core/meeting';
import { Store } from '../../core/store';
import { manualNode, setManualNode } from '../../core/node-choice';
import { allowed } from '../../core/permissions';
import { currentServerUrl, rememberServer, serverLabel, thisServer } from '../../core/servers';
import { session } from '../../core/session';
import { failureText } from '../../core/failure';
import { locale } from '../../i18n';
import { nodeProbe, score, type NodeInfo, type ProbeResult } from '../../media/node-probe';
import { useStore } from '../primitives';
import { Button, Switch } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { rowText } from './sections';

/**
 * С чем говорит этот клиент — другой вопрос, чем «кто вы на нём», поэтому не в «Профиле».
 *
 * Продукт — один адрес, а встреча живёт на одном медиаузле (R195). Узел по умолчанию выбирает система —
 * «Авто»: по измеренному с этого устройства пути и по загрузке узлов. Но выбрать можно и руками (R200,
 * владелец: «по дефолту сервер auto, сделать возможность выбора… список регионов с флагами и их
 * загруженностью»): тот же список узлов с флагом, городом, замером и палочками загрузки.
 *
 * - Вне встречи выбор относится к **следующей** встрече, которую создаст этот человек, и помнится на
 *   устройстве (`core/node-choice.ts`); «Авто» сбрасывает.
 * - Во встрече тот же список **переводит эту встречу**: пока — через переназначение комнаты с
 *   восстановлением у всех (пара секунд без звука — об этом говорится прямо), потом — тёплый переезд без
 *   разрыва (`server-selection.md` §4). Право — `media.move` из `you.can` (Р-104: создатель).
 *
 * Пароль сервера и PING — как прежде. Строки «Подключаться автоматически» нет ни в браузере (R135), ни в
 * приложении: сервер один, подключение к нему всегда само.
 */
export function ServerSection({
  showPing,
  changePing,
  /** Идущая встреча — тогда список переводит её, а не выбирает узел следующей; вне встречи — null. */
  meeting = null,
}: {
  showPing: boolean;
  changePing: (showPing: boolean) => void;
  meeting?: Meeting | null;
}) {
  const { t } = useTranslation();
  const current = useStore(session);
  const [saved, setSaved] = useState(thisServer);
  const load = useServerLoad();
  const nodes = nodeProbe.known();
  const several = nodes.length > 1;
  const loads = useNodesLoad(several);
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
  const ms = (id: string) => {
    const measure = probe?.measures.find((m) => m.node === id);
    return measure ? score(measure) : null;
  };
  const title = (id: string) => nodeProbe.title(id, language);
  const country = (id: string) =>
    loads?.find((n) => n.id === id)?.country ?? nodes.find((n) => n.id === id)?.country;
  // Один узел — строка «Хельсинки · 12 мс», выбирать не из чего. Один узел не мерят (нечего сравнивать), поэтому без
  // замера — просто имя: «не отвечает» было бы неправдой о живом узле. Узел без имени — неявный, без реестра (стенд,
  // продукт до подключения узлов): о нём строке сказать нечего, её нет.
  const named = nodes.filter((node) => title(node.id) !== node.id);
  const singleLine = named
    .map((node) => {
      const latency = ms(node.id);
      return latency === null
        ? title(node.id)
        : t(($) => $.settings.server.nodeMs, { node: title(node.id), ms: latency });
    })
    .join(', ');
  // Имя сервера, совпадающее с адресом, — один раз, а не «cord.nikg.tech · cord.nikg.tech».
  const serverName = current?.name || serverLabel(saved);
  const serverHost = new URL(currentServerUrl()).host;
  return (
    <SettingGroup title={t(($) => $.settings.server.connection)}>
      <SettingRow
        id="server-current"
        hint={
          <>
            {serverName && serverName !== serverHost ? `${serverName} · ${serverHost}` : serverHost}
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
      {several ? (
        <SettingRow
          id="server-node"
          stack
          below={
            <NodeList nodes={nodes} loads={loads} ms={ms} title={title} country={country} meeting={meeting} />
          }
        />
      ) : (
        named.length > 0 && <SettingRow id="server-node" hint={singleLine} />
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

/** Узел, на который встречу не поставить: мёртв, на дренаже или без мест — серый, без радио. */
function unavailable(load: NodeLoad | undefined) {
  return !!load && (load.state === 'down' || load.state === 'drained' || load.state === 'full');
}

function NodeList({
  nodes,
  loads,
  ms,
  title,
  country,
  meeting,
}: {
  nodes: readonly NodeInfo[];
  loads: NodeLoad[] | null;
  ms: (id: string) => number | null;
  title: (id: string) => string;
  country: (id: string) => string | undefined;
  meeting: Meeting | null;
}) {
  const { t } = useTranslation();
  const manual = useStore(manualNode);
  const snapshot = useStore(meeting?.snapshot ?? fallbackSnapshot);
  const ended = useStore(meeting?.ended ?? fallbackEnded);
  const inMeeting = !!meeting && !ended;
  const meetingNode = inMeeting ? (snapshot?.mediaNode ?? null) : null;
  const mayMove = inMeeting && !!snapshot && allowed(snapshot, meeting.admission.participantId, 'media.move');
  const [pending, setPending] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Переезд состоялся — снимок назвал новый узел: радио встаёт на него само.
  useEffect(() => {
    if (moving && meetingNode === moving) {
      setMoving(null);
      setPending(null);
    }
  }, [meetingNode, moving]);
  const checked = inMeeting ? meetingNode : (manual ?? 'auto');
  const ordered = [...nodes].sort((a, b) => {
    if (a.id === meetingNode) return -1;
    if (b.id === meetingNode) return 1;
    return (ms(a.id) ?? Infinity) - (ms(b.id) ?? Infinity);
  });
  const choose = (id: string) => {
    setError('');
    if (!inMeeting) {
      setManualNode(id === 'auto' ? null : id);
      return;
    }
    if (id === meetingNode) {
      setPending(null);
      return;
    }
    setPending(id);
  };
  const move = async () => {
    if (!meeting || !pending) return;
    const to = pending;
    setMoving(to);
    setError('');
    try {
      await meeting.api.moveMedia(to, crypto.randomUUID());
    } catch (e) {
      setMoving(null);
      setPending(null);
      setError(failureText(e, 'meeting'));
    }
  };
  const label = rowText(t, 'server-node').label;
  return (
    <div className="node-list" data-meeting={inMeeting || undefined}>
      <div role="radiogroup" aria-label={label} className="node-list__options">
        {!inMeeting && (
          <NodeOption
            value="auto"
            name="cord-node"
            checked={checked === 'auto'}
            onChoose={choose}
            text={t(($) => $.settings.server.auto)}
            hint={t(($) => $.settings.server.autoHint)}
          />
        )}
        {ordered.map((node) => {
          const load = loads?.find((n) => n.id === node.id);
          const latency = ms(node.id);
          const isCurrent = node.id === meetingNode;
          const blocked = !isCurrent && (unavailable(load) || (inMeeting && !mayMove));
          return (
            <NodeOption
              key={node.id}
              value={node.id}
              name="cord-node"
              checked={checked === node.id}
              disabled={blocked}
              busy={moving === node.id}
              onChoose={choose}
              flag={country(node.id)}
              text={title(node.id)}
              hint={
                isCurrent
                  ? t(($) => $.settings.server.thisMeeting)
                  : load?.state === 'down'
                    ? t(($) => $.settings.server.nodeDown)
                    : load?.state === 'drained'
                      ? t(($) => $.settings.server.nodeDrained)
                      : latency === null
                        ? t(($) => $.settings.server.nodeDown)
                        : t(($) => $.settings.server.nodeMsShort, { ms: latency })
              }
              aside={
                load && load.state !== 'down' && load.state !== 'drained' ? (
                  <LoadBars level={load.level} state={load.state} withText />
                ) : null
              }
            />
          );
        })}
      </div>
      {!inMeeting && manual && <p className="node-list__note">{t(($) => $.settings.server.manualHint)}</p>}
      {inMeeting && !mayMove && <p className="node-list__note">{t(($) => $.settings.server.creatorOnly)}</p>}
      {inMeeting && mayMove && !pending && !moving && (
        <p className="node-list__note">{t(($) => $.settings.server.autoCreated)}</p>
      )}
      {inMeeting && pending && !moving && (
        <div
          className="node-list__confirm"
          role="group"
          aria-label={t(($) => $.settings.server.moveAsk, { node: title(pending) })}
        >
          <p className="node-list__ask">
            <strong>{t(($) => $.settings.server.moveAsk, { node: title(pending) })}</strong>{' '}
            {t(($) => $.settings.server.moveNote)}
          </p>
          <div className="node-list__actions">
            <Button size="sm" variant="primary" onClick={() => void move()}>
              {t(($) => $.settings.server.move)}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setPending(null)}>
              {t(($) => $.common.cancel)}
            </Button>
          </div>
        </div>
      )}
      {moving && (
        <p className="node-list__note" role="status">
          {t(($) => $.settings.server.moving, { node: title(moving) })}
        </p>
      )}
      {error && (
        <p className="node-list__note" role="alert" data-tone="danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Вне встречи снимка нет — пустые магазины, чтобы хуки звались всегда одинаково. */
const fallbackSnapshot = new Store<Snapshot | null>(null);
const fallbackEnded = new Store<string | null>(null);

function NodeOption({
  value,
  name,
  checked,
  disabled = false,
  busy = false,
  onChoose,
  flag,
  text,
  hint,
  aside,
}: {
  value: string;
  name: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChoose: (value: string) => void;
  flag?: string | null;
  text: string;
  hint?: string;
  aside?: ReactNode;
}) {
  return (
    <label
      className="node-option"
      data-checked={checked || undefined}
      data-disabled={disabled || undefined}
      data-busy={busy || undefined}
    >
      <input
        type="radio"
        className="node-option__input"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChoose(value)}
      />
      <span className="node-option__mark" aria-hidden="true" />
      {flag !== undefined && <Flag country={flag} className="node-option__flag" />}
      <span className="node-option__text">
        <span className="node-option__title">{text}</span>
        {hint && <span className="node-option__hint">{hint}</span>}
      </span>
      {aside && <span className="node-option__aside">{aside}</span>}
    </label>
  );
}
