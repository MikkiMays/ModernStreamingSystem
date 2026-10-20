import { useEffect, useState } from 'react';
import { DoorOpen, Puzzle, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { Modal, useStore } from './primitives';

/**
 * Что за встреча и кого в неё пускать.
 *
 * Оба поля записывались ровно один раз, при создании, и поменять их было нечем: опечатку в
 * названии комната несла до конца, а решение «пускаю всех» приходилось принимать до того,
 * как стало понятно, кто придёт. Хуже того, выбор прятался за шестерёнкой на экране
 * предпросмотра галочкой «Подтверждать вход по приглашению» — формулировкой, по которой не
 * видно, что будет с теми, кто уже идёт по ссылке.
 *
 * Правка разъезжается всем сама: сервер объявляет `room.changed`, и снимок перечитывают все.
 */
export function MeetingSettings({
  meeting,
  open,
  onOpenChange,
}: {
  meeting: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const [title, setTitle] = useState(snapshot.title);
  const [approval, setApproval] = useState(snapshot.approvalRequired);
  const [integrations, setIntegrations] = useState(snapshot.integrationsAllowed !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Пока диалог закрыт, поля следуют за комнатой: её мог переименовать другой ведущий.
  useEffect(() => {
    if (!open) {
      setTitle(snapshot.title);
      setApproval(snapshot.approvalRequired);
      setIntegrations(snapshot.integrationsAllowed !== false);
      setError('');
    }
  }, [open, snapshot.title, snapshot.approvalRequired, snapshot.integrationsAllowed]);
  const integrationsChanged = integrations !== (snapshot.integrationsAllowed !== false);
  const changed =
    title.trim() !== snapshot.title || approval !== snapshot.approvalRequired || integrationsChanged;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      // Две ручки ядра, одна кнопка: разрешение интеграций проверяется на каждую команду
      // сервиса и живёт отдельно от названия и входа. Человеку об этом знать незачем.
      if (integrationsChanged) await meeting.api.integrations(integrations);
      await meeting.api.settings({ title: title.trim(), approvalRequired: approval });
      await meeting.refresh();
      onOpenChange(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t(($) => $.meeting.settings.saveFailed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t(($) => $.meeting.settings.title)}
      description={t(($) => $.meeting.settings.description)}
    >
      <div className="settings-form">
        <label>
          {t(($) => $.meeting.settings.name)}
          <input
            value={title}
            maxLength={80}
            autoComplete="off"
            placeholder={t(($) => $.meeting.settings.namePlaceholder)}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <section className="audio-settings" aria-label={t(($) => $.meeting.settings.access)}>
          <h3>
            <DoorOpen size={19} /> {t(($) => $.meeting.settings.access)}
          </h3>
          <div role="radiogroup" aria-label={t(($) => $.meeting.settings.access)} className="network-modes">
            <label className="check-setting">
              <input type="radio" name="admission" checked={!approval} onChange={() => setApproval(false)} />
              <span>
                {t(($) => $.meeting.settings.open)}
                <small>{t(($) => $.meeting.settings.openHint)}</small>
              </span>
            </label>
            <label className="check-setting">
              <input type="radio" name="admission" checked={approval} onChange={() => setApproval(true)} />
              <span>
                {t(($) => $.meeting.settings.approval)}
                <small>{t(($) => $.meeting.settings.approvalHint)}</small>
              </span>
            </label>
          </div>
          <p className="form-footnote">
            <ShieldCheck size={14} /> {t(($) => $.meeting.settings.linkStays)}
          </p>
        </section>
        {/*
          Кому можно приносить во встречу постороннее — вопрос про встречу, а не про музыку, и
          стоять ему здесь, рядом с «кого пускать». Раньше эта галочка жила на панели
          интеграций — то есть её видел только тот, кто и так туда зашёл, и находилась она
          дважды: и на витрине, и внутри музыки.
        */}
        <section className="audio-settings" aria-label={t(($) => $.meeting.settings.integrations)}>
          <h3>
            <Puzzle size={19} /> {t(($) => $.meeting.settings.integrations)}
          </h3>
          <label className="check-setting">
            <input
              type="checkbox"
              checked={integrations}
              onChange={(e) => setIntegrations(e.target.checked)}
            />
            <span>
              {t(($) => $.meeting.settings.integrationsAll)}
              <small>{t(($) => $.meeting.settings.integrationsHint)}</small>
            </span>
          </label>
        </section>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary full"
          disabled={busy || !changed || !title.trim()}
          onClick={() => void save()}
        >
          {busy
            ? t(($) => $.meeting.settings.saving)
            : changed
              ? t(($) => $.meeting.settings.save)
              : t(($) => $.meeting.settings.unchanged)}
        </button>
      </div>
    </Modal>
  );
}
