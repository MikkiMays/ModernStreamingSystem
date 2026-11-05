import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { useStore } from './primitives';
import './own-camera-chip.css';

const QUIET = new Store({ healing: false, backgroundOff: false });

/**
 * Метка на своей плитке (R189, И6): «Камера переподключается…», пока сторож камеры лечит захват, и
 * «Фон отключён», когда конвейер фона снят ради живой камеры. Только у себя и только метка — не плашка:
 * зрителям об этом не говорится, а кнопка камеры остаётся «включена». Отдельный компонент, чтобы
 * отрисовка видео на сцене (`Stage.tsx`) от него не зависела.
 */
export function OwnCameraChip({ meeting }: { meeting: Pick<Meeting, 'media'> }) {
  const { t } = useTranslation();
  const note = useStore(meeting.media.cameraNote ?? QUIET);
  if (!note.healing && !note.backgroundOff) return null;
  return (
    <div className="own-camera-chip" role="status" data-kind={note.healing ? 'healing' : 'background'}>
      {note.healing ? t(($) => $.stage.cameraHealing) : t(($) => $.stage.backgroundOff)}
    </div>
  );
}
