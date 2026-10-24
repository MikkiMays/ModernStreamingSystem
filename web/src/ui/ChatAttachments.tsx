import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { File as FileIcon, X } from 'lucide-react';
import { formatBytes } from './chat';
import { IconButton } from './kit';
import './chat-attachments.css';

/** Вложение, которое ждёт отправки над полем чата. */
export interface PendingFile {
  id: string;
  file: File;
}

/**
 * Вложения над полем чата до отправки (R94) — как у GPT и Claude: миниатюра скриншота или значок
 * файла, имя и размер, крестик «Убрать». Уходят вместе с текстом по Enter (`Sidebar`), а не сразу
 * после выбора: подпись к скриншоту пишут, уже видя его.
 */
export function ChatAttachments({
  files,
  onRemove,
}: {
  files: PendingFile[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (!files.length) return null;
  return (
    <ul className="chat-attachments" aria-label={t(($) => $.sidebar.attachment.list)}>
      {files.map(({ id, file }) => (
        <li key={id} className="chat-attachment">
          <Thumbnail file={file} />
          <span className="chat-attachment__text">
            <span className="chat-attachment__name" title={file.name}>
              {file.name}
            </span>
            <span className="chat-attachment__size">{formatBytes(t, file.size)}</span>
          </span>
          <IconButton
            size="sm"
            className="chat-attachment__remove"
            label={t(($) => $.sidebar.attachment.remove, { name: file.name })}
            onClick={() => onRemove(id)}
          >
            <X />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

/** Миниатюра картинки — по ссылке на сам файл в памяти вкладки; ссылка отпускается вместе с превью. */
function Thumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <span className="chat-attachment__thumb" aria-hidden="true">
      {url ? <img src={url} alt="" /> : <FileIcon />}
    </span>
  );
}
