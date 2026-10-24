import { useEffect, useId, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { useStore } from './primitives';
import { Button, Dialog, Field, Input, Segmented, Switch } from './kit';
import './meeting-settings.css';

type Access = 'open' | 'approval';

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
 *
 * Вид (R53–R56): окно набора с кнопкой в подвале, без подзаголовка «Меняет только организатор…»
 * (окно и так видит только он); «Кто может войти» — сегментом, под ним одной строкой — что
 * значит выбранное; интеграции — переключателем (X4), без заголовка «Интеграции» и без «Громкость
 * каждый всё равно ставит себе сам». «Сохранить» выключена, пока ничего не поменялось, и
 * выглядит выключенной.
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
  const accessId = useId();
  const access: Access = approval ? 'approval' : 'open';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(($) => $.meeting.settings.title)}
      className="meeting-settings"
      footer={
        <Button
          variant="primary"
          loading={busy}
          disabled={!changed || !title.trim()}
          onClick={() => void save()}
        >
          {t(($) => $.meeting.settings.save)}
        </Button>
      }
    >
      <div className="meeting-settings__fields">
        <Field label={t(($) => $.meeting.settings.name)}>
          <Input
            value={title}
            maxLength={80}
            autoComplete="off"
            placeholder={t(($) => $.meeting.settings.namePlaceholder)}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <div className="meeting-settings__group" role="group" aria-labelledby={accessId}>
          <span className="meeting-settings__label" id={accessId}>
            {t(($) => $.meeting.settings.access)}
          </span>
          <Segmented<Access>
            full
            aria-labelledby={accessId}
            value={access}
            onValueChange={(next) => setApproval(next === 'approval')}
            options={[
              { value: 'open', label: t(($) => $.meeting.settings.open) },
              { value: 'approval', label: t(($) => $.meeting.settings.approval) },
            ]}
          />
          <p className="meeting-settings__hint">
            {approval ? t(($) => $.meeting.settings.approvalHint) : t(($) => $.meeting.settings.openHint)}
          </p>
          <p className="meeting-settings__note">
            <ShieldCheck aria-hidden="true" />
            <span>{t(($) => $.meeting.settings.linkStays)}</span>
          </p>
        </div>
        {/*
          Кому можно приносить во встречу постороннее — вопрос про встречу, а не про музыку, и
          стоять ему здесь, рядом с «кого пускать». Раньше эта галочка жила на панели
          интеграций — то есть её видел только тот, кто и так туда зашёл, и находилась она
          дважды: и на витрине, и внутри музыки. Теперь это переключатель (R55, X4).
        */}
        <Switch
          className="meeting-settings__switch"
          checked={integrations}
          onCheckedChange={setIntegrations}
          label={t(($) => $.meeting.settings.integrationsAll)}
          description={t(($) => $.meeting.settings.integrationsHint)}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
