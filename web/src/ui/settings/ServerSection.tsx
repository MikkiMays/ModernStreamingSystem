import { useNodesLoad, useServerLoad, type NodeLoad } from '../../core/server-load';
import { LoadBars } from '../kit/LoadBars';
import { Flag } from '../kit/Flag';
import { Popover } from '../kit/Popover';
import { PHONE_QUERY, useMediaQuery } from '../kit/useMediaQuery';
import { Check, ChevronDown, LocateFixed } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { SettingGroup, SettingRow, type RowA11y } from './Row';
import { rowText } from './sections';

/**
 * С чем говорит этот клиент — другой вопрос, чем «кто вы на нём», поэтому не в «Профиле».
 *
 * Продукт — один адрес, а встреча живёт на одном медиаузле (R195). Узел по умолчанию выбирает система —
 * «Авто»: по измеренному с этого устройства пути и по загрузке узлов. Но выбрать можно и руками (R200,
 * владелец: «по дефолту сервер auto, сделать возможность выбора… список регионов с флагами и их
 * загруженностью»): тот же список узлов с флагом, городом, замером и палочками загрузки.
 *
 * Список сразу не показывается (R220, владелец 09.11: «не нужно сразу показывать сервера, а просто кнопку…
 * Авто, и если нажать, то будет либо окно либо какой-то выбор»): в строке — кнопка с текущим выбором («Авто»
 * или узел с флагом), по нажатию — список: карточка у кнопки на компьютере, лист снизу на телефоне (`Popover`).
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
        <NodePicker
          nodes={nodes}
          loads={loads}
          ms={ms}
          title={title}
          country={country}
          meeting={meeting}
          nearest={probe?.node ?? null}
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

interface PickerOption {
  value: string;
  text: string;
  hint?: string;
  flag?: string;
  icon?: ReactNode;
  aside?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
}

function NodePicker({
  nodes,
  loads,
  ms,
  title,
  country,
  meeting,
  nearest,
}: {
  nodes: readonly NodeInfo[];
  loads: NodeLoad[] | null;
  ms: (id: string) => number | null;
  title: (id: string) => string;
  country: (id: string) => string | undefined;
  meeting: Meeting | null;
  /** Узел, который «Авто» выбрало бы сейчас по замеру. */
  nearest: string | null;
}) {
  const { t } = useTranslation();
  const phone = useMediaQuery(PHONE_QUERY);
  const manual = useStore(manualNode);
  const snapshot = useStore(meeting?.snapshot ?? fallbackSnapshot);
  const ended = useStore(meeting?.ended ?? fallbackEnded);
  const inMeeting = !!meeting && !ended;
  const meetingNode = inMeeting ? (snapshot?.mediaNode ?? null) : null;
  const mayMove = inMeeting && !!snapshot && allowed(snapshot, meeting.admission.participantId, 'media.move');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const valueId = useId();
  // Переезд состоялся — снимок назвал новый узел: выбор встаёт на него сам.
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
    setOpen(false);
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
  const nearestLatency = nearest ? ms(nearest) : null;
  const options: PickerOption[] = [
    ...(inMeeting
      ? []
      : [
          {
            value: 'auto',
            text: t(($) => $.settings.server.autoRecommended),
            icon: <LocateFixed />,
            hint:
              nearest && nearestLatency !== null
                ? t(($) => $.settings.server.autoNow, {
                    node: t(($) => $.settings.server.nodeMs, { node: title(nearest), ms: nearestLatency }),
                  })
                : t(($) => $.settings.server.autoHint),
          },
        ]),
    ...ordered.map((node): PickerOption => {
      const load = loads?.find((n) => n.id === node.id);
      const latency = ms(node.id);
      const isCurrent = node.id === meetingNode;
      return {
        value: node.id,
        text: title(node.id),
        flag: country(node.id),
        disabled: !isCurrent && (unavailable(load) || (inMeeting && !mayMove)),
        busy: moving === node.id,
        hint: isCurrent
          ? t(($) => $.settings.server.thisMeeting)
          : load?.state === 'down'
            ? t(($) => $.settings.server.nodeDown)
            : load?.state === 'drained'
              ? t(($) => $.settings.server.nodeDrained)
              : latency === null
                ? t(($) => $.settings.server.nodeDown)
                : t(($) => $.settings.server.nodeMsShort, { ms: latency }),
        aside:
          load && load.state !== 'down' && load.state !== 'drained' ? (
            <LoadBars level={load.level} state={load.state} withText />
          ) : null,
      };
    }),
  ];
  const current = options.find((o) => o.value === checked) ?? null;
  const currentText = checked === 'auto' ? t(($) => $.settings.server.auto) : (current?.text ?? '—');
  const trigger = (a11y: RowA11y) => (
    <button
      type="button"
      className="node-picker__trigger"
      aria-labelledby={`${a11y['aria-labelledby']} ${valueId}`}
      aria-describedby={a11y['aria-describedby']}
      data-busy={moving ? true : undefined}
    >
      {checked === 'auto' ? (
        <LocateFixed className="node-picker__auto" aria-hidden="true" />
      ) : current?.flag !== undefined ? (
        <Flag country={current.flag} className="node-option__flag" />
      ) : null}
      <span className="node-picker__value" id={valueId}>
        {currentText}
      </span>
      <ChevronDown className="node-picker__chevron" aria-hidden="true" />
    </button>
  );
  return (
    <SettingRow
      id="server-node"
      stack
      below={
        (inMeeting || manual || pending || moving || error) && (
          <div className="node-list" data-meeting={inMeeting || undefined}>
            {!inMeeting && manual && (
              <p className="node-list__note">{t(($) => $.settings.server.manualHint)}</p>
            )}
            {inMeeting && !mayMove && (
              <p className="node-list__note">{t(($) => $.settings.server.creatorOnly)}</p>
            )}
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
        )
      }
    >
      {(a11y) => (
        <Popover
          trigger={trigger(a11y)}
          open={open}
          onOpenChange={setOpen}
          title={phone ? label : undefined}
          align="end"
          className="node-picker"
        >
          <NodeListbox options={options} checked={checked} onChoose={choose} label={label} />
        </Popover>
      )}
    </SettingRow>
  );
}

/**
 * Список узлов — `listbox` по образцу WAI-ARIA: фокус встаёт на выбранный пункт, стрелки и Home/End ходят по
 * доступным, Enter или пробел выбирают, Esc закрывает (это делает `Popover`). Недоступный узел виден, но не
 * выбирается и пропускается стрелками.
 */
function NodeListbox({
  options,
  checked,
  onChoose,
  label,
}: {
  options: readonly PickerOption[];
  checked: string | null;
  onChoose: (value: string) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  const selected = options.findIndex((option) => option.value === checked);
  const [active, setActive] = useState(() => (selected >= 0 ? selected : (enabled[0] ?? 0)));
  useEffect(() => {
    // Карточка открылась — фокус на выбранный пункт; после её собственного фокуса, поэтому кадром позже.
    const frame = requestAnimationFrame(() => refs.current[active]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active]);
  const step = (event: KeyboardEvent) => {
    const at = enabled.indexOf(active);
    const next =
      event.key === 'ArrowDown'
        ? enabled[Math.min(enabled.length - 1, at + 1)]
        : event.key === 'ArrowUp'
          ? enabled[Math.max(0, at - 1)]
          : event.key === 'Home'
            ? enabled[0]
            : event.key === 'End'
              ? enabled[enabled.length - 1]
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };
  return (
    <div className="node-picker__list" role="listbox" aria-label={label} onKeyDown={step}>
      {options.map((option, index) => {
        const isChecked = option.value === checked;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="option"
            className="node-picker__option"
            aria-selected={isChecked}
            aria-disabled={option.disabled || undefined}
            data-checked={isChecked || undefined}
            data-disabled={option.disabled || undefined}
            data-busy={option.busy || undefined}
            tabIndex={index === active ? 0 : -1}
            onFocus={() => setActive(index)}
            onClick={() => {
              if (!option.disabled) onChoose(option.value);
            }}
          >
            <span className="node-picker__lead" aria-hidden={option.icon ? true : undefined}>
              {option.icon ??
                (option.flag !== undefined && <Flag country={option.flag} className="node-option__flag" />)}
            </span>
            <span className="node-option__text">
              <span className="node-option__title">{option.text}</span>
              {option.hint && <span className="node-option__hint">{option.hint}</span>}
            </span>
            {option.aside && <span className="node-option__aside">{option.aside}</span>}
            <Check className="node-picker__check" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/** Вне встречи снимка нет — пустые магазины, чтобы хуки звались всегда одинаково. */
const fallbackSnapshot = new Store<Snapshot | null>(null);
const fallbackEnded = new Store<string | null>(null);
