import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MusicState } from '../core/services';
import { Button } from './kit';

/**
 * Свои файлы в общую очередь (R43): одна пунктирная зона, в ней по центру столбиком — значок,
 * «Перетащите аудиофайлы сюда», кнопка выбора и мелко пределы. Снаружи рамки нет ничего: раньше
 * кнопка и вторая строка-повтор стояли под рамкой, прижатые влево, и кнопка вылезала за её край.
 *
 * Перетащить можно на всю зону; пока файлы над ней, зона подсвечена (`data-over`). На телефоне
 * перетаскивать нечем — там остаётся одна кнопка (`integrations.css`). Пока файлы уходят, вместо
 * пределов — «Отменить»: передумать можно и посреди загрузки.
 */
export function MusicUpload({
  canUse,
  maxFileBytes,
  upload,
  onAdded,
  onError,
}: {
  canUse: boolean;
  maxFileBytes: number;
  upload: (file: File, signal: AbortSignal) => Promise<MusicState>;
  onAdded: (state: MusicState) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const limit = Math.round(maxFileBytes / (1024 * 1024));
  const send = async (files: File[]) => {
    if (!canUse || busy || !files.length) return;
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      for (const file of files) {
        if (file.size > maxFileBytes)
          throw new Error(t(($) => $.music.upload.tooBig, { name: file.name, limit }));
        onAdded(await upload(file, controller.signal));
      }
    } catch (e) {
      if (!controller.signal.aborted) onError((e as Error).message);
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };
  return (
    <div
      className="music-drop"
      data-over={over || undefined}
      data-disabled={!canUse || undefined}
      onDragOver={(e) => {
        if (!canUse || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void send(Array.from(e.dataTransfer.files));
      }}
    >
      <Upload size={24} className="music-drop__icon" aria-hidden="true" />
      <p className="music-drop__title">{t(($) => $.music.platforms.upload.drop)}</p>
      <input
        ref={input}
        type="file"
        multiple
        accept="audio/*,.m4a,.flac,.ogg,.opus,.webm"
        hidden
        aria-label={t(($) => $.music.upload.input)}
        onChange={(e) => {
          void send(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <Button
        size="sm"
        className="music-drop__pick"
        icon={<Upload />}
        loading={busy}
        disabled={!canUse}
        onClick={() => input.current?.click()}
      >
        {t(($) => $.music.upload.button)}
      </Button>
      {busy ? (
        <Button variant="quiet" size="sm" onClick={() => abort.current?.abort()}>
          {t(($) => $.music.upload.cancel)}
        </Button>
      ) : (
        <small className="music-drop__hint">{t(($) => $.music.upload.hint, { limit })}</small>
      )}
    </div>
  );
}
