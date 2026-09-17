import { useEffect, useState } from 'react';
import { DoorOpen, ShieldCheck } from 'lucide-react';
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
  const snapshot = useStore(meeting.snapshot);
  const [title, setTitle] = useState(snapshot.title);
  const [approval, setApproval] = useState(snapshot.approvalRequired);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Пока диалог закрыт, поля следуют за комнатой: её мог переименовать другой ведущий.
  useEffect(() => {
    if (!open) {
      setTitle(snapshot.title);
      setApproval(snapshot.approvalRequired);
      setError('');
    }
  }, [open, snapshot.title, snapshot.approvalRequired]);
  const changed = title.trim() !== snapshot.title || approval !== snapshot.approvalRequired;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await meeting.api.settings({ title: title.trim(), approvalRequired: approval });
      await meeting.refresh();
      onOpenChange(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Настройки встречи"
      description="Меняет только организатор. Остальные увидят это сразу."
    >
      <div className="settings-form">
        <label>
          Название встречи
          <input
            value={title}
            maxLength={80}
            autoComplete="off"
            placeholder="Например, Вечер с друзьями"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <section className="audio-settings" aria-label="Кто может войти">
          <h3>
            <DoorOpen size={19} /> Кто может войти
          </h3>
          <div role="radiogroup" aria-label="Кто может войти" className="network-modes">
            <label className="check-setting">
              <input type="radio" name="admission" checked={!approval} onChange={() => setApproval(false)} />
              <span>
                По ссылке и коду — сразу
                <small>Кто открыл приглашение, тот и вошёл. Подходит для своих.</small>
              </span>
            </label>
            <label className="check-setting">
              <input type="radio" name="admission" checked={approval} onChange={() => setApproval(true)} />
              <span>
                Только с вашего подтверждения
                <small>Каждый входящий ждёт, пока вы его впустите. Уже вошедших это не выгоняет.</small>
              </span>
            </label>
          </div>
          <p className="form-footnote">
            <ShieldCheck size={14} /> Ссылка и код у встречи не меняются. Чтобы закрыть доступ по старой
            ссылке, отзовите приглашение и создайте новое.
          </p>
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
          {busy ? 'Сохраняем…' : changed ? 'Сохранить' : 'Ничего не поменялось'}
        </button>
      </div>
    </Modal>
  );
}
