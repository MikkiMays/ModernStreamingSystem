import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Upload } from 'lucide-react';
import type { MusicState } from '../core/services';

/** Свои файлы в общую очередь: кнопка, перетаскивание и возможность передумать. */
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
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const send = async (files: File[]) => {
    if (!canUse || busy || !files.length) return;
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      for (const file of files) {
        if (file.size > maxFileBytes) throw new Error(`«${file.name}»: максимум 50 МБ на трек`);
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
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void send(Array.from(e.dataTransfer.files));
      }}
    >
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
      <button
        className="button secondary full"
        disabled={!canUse || busy}
        onClick={() => input.current?.click()}
      >
        {busy ? <LoaderCircle size={18} className="spin" /> : <Upload size={18} />}
        {busy ? 'Добавляем треки…' : 'Добавить аудиофайлы'}
      </button>
      {busy && (
        <button className="button ghost" onClick={() => abort.current?.abort()}>
          Отменить загрузку
        </button>
      )}
      <p className="form-footnote">
        Можно перетащить сюда несколько файлов. До 50 МБ и 60 минут на трек; файлы хранятся до суток.
      </p>
    </div>
  );
}
