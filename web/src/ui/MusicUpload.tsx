import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Upload } from 'lucide-react';
import type { MusicState } from '../core/services';
import { Button } from './kit';

/**
 * Свои файлы в общую очередь: кнопка, перетаскивание и возможность передумать.
 *
 * Перетащить файлы можно на весь блок «Добавить» — поле поиска и кнопку вместе (`children`): цель
 * размером с палец мышью не находится, а блок виден целиком. Пока файлы над ним, блок подсвечен.
 */
export function MusicUpload({
  canUse,
  maxFileBytes,
  upload,
  onAdded,
  onError,
  children,
}: {
  canUse: boolean;
  maxFileBytes: number;
  upload: (file: File, signal: AbortSignal) => Promise<MusicState>;
  onAdded: (state: MusicState) => void;
  onError: (message: string) => void;
  children?: ReactNode;
}) {
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
        if (file.size > maxFileBytes) throw new Error(`«${file.name}»: максимум ${limit} МБ на трек`);
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
      className="music-add"
      data-over={over || undefined}
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
      {children}
      <div className="music-add__files">
        <input
          ref={input}
          type="file"
          multiple
          accept="audio/*,.m4a,.flac,.ogg,.opus,.webm"
          hidden
          aria-label="Добавить музыкальные файлы"
          onChange={(e) => {
            void send(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <Button
          variant="quiet"
          size="sm"
          icon={<Upload />}
          loading={busy}
          disabled={!canUse}
          onClick={() => input.current?.click()}
        >
          Загрузить файлы
        </Button>
        {busy ? (
          <Button variant="quiet" size="sm" onClick={() => abort.current?.abort()}>
            Отменить
          </Button>
        ) : (
          <span className="music-add__hint">Можно и перетащить: до {limit} МБ и 60 минут на трек</span>
        )}
      </div>
    </div>
  );
}
