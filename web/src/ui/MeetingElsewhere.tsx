import { ArrowRight, LogOut } from 'lucide-react';
import type { ElsewhereMeeting } from '../core/identity';
import { Button, Dialog } from './kit';
import './meeting-elsewhere.css';

/**
 * «Вы уже во встрече «X»» — выбор, когда ядро не пускает во вторую встречу (T52, П13).
 *
 * Ядро отвечает на вход `409 ALREADY_IN_MEETING {roomId, title}`, и человек выбирает словами, а
 * не «ОК/Отмена»: «Перейти туда» — вернуться в ту встречу, «Выйти оттуда и войти сюда» — повторить
 * вход с `X-Cord-Leave`, и ядро в одном шаге выведет из той встречи обычным выходом и впустит в эту.
 * Закрыть окно — остаться где был.
 *
 * `note` — когда в ту встречу отсюда не попасть (ни соседняя вкладка, ни прежний вход, ни
 * избранное её не знают): окно говорит почему, и второй выбор остаётся.
 */
export function MeetingElsewhere({
  meeting,
  busy,
  note,
  onGo,
  onMove,
  onClose,
}: {
  meeting: ElsewhereMeeting | null;
  /** Что сейчас выполняется: переход туда или выход оттуда со входом сюда. */
  busy?: 'go' | 'move';
  note?: string;
  onGo: () => void;
  onMove: () => void;
  onClose: () => void;
}) {
  if (!meeting) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      size="md"
      className="meeting-elsewhere"
      title={`Вы уже во встрече «${meeting.title}»`}
      description="С одного устройства можно быть только в одной встрече за раз."
      closeLabel="Остаться"
      footer={
        <>
          <Button
            variant="secondary"
            icon={<ArrowRight size={18} />}
            loading={busy === 'go'}
            disabled={!!busy}
            onClick={onGo}
          >
            Перейти туда
          </Button>
          <Button
            variant="primary"
            icon={<LogOut size={18} />}
            loading={busy === 'move'}
            disabled={!!busy}
            onClick={onMove}
          >
            Выйти оттуда и войти сюда
          </Button>
        </>
      }
    >
      {note && (
        <p className="meeting-elsewhere__note" role="status">
          {note}
        </p>
      )}
    </Dialog>
  );
}
