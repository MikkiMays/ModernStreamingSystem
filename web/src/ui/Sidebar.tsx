import { Tabs } from '@base-ui/react/tabs';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Download,
  File,
  FileUp,
  MicOff,
  Paperclip,
  Pause,
  Play,
  Send,
  UserPlus,
  UserX,
  X,
} from 'lucide-react';
import type { Meeting } from '../core/meeting';
import { Avatar, IconButton, useStore } from './primitives';
import { Track } from 'livekit-client';
import { Services } from './Services';
import { ParticipantMenu } from './ParticipantMenu';

export type Panel = 'people' | 'chat' | 'services';
function formatBytes(value: number) {
  return value >= 1048576 ? (value / 1048576).toFixed(1) + ' МиБ' : Math.ceil(value / 1024) + ' КиБ';
}
export function Sidebar({
  meeting,
  panel,
  setPanel,
  onClose,
  onInvite,
}: {
  meeting: Meeting;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  onClose: () => void;
  onInvite: () => void;
}) {
  const snapshot = useStore(meeting.snapshot);
  const revision = useStore(meeting.fileRevision);
  const ended = useStore(meeting.ended);
  const uploading = useStore(meeting.uploader.state);
  const tracks = useStore(meeting.media.tracks);
  const [now, setNow] = useState(Date.now);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const files = useQuery({
    queryKey: ['files', snapshot.id, meeting.admission.participantId],
    queryFn: meeting.api.files,
    refetchInterval: panel === 'chat' ? 5000 : false,
  });
  useEffect(() => {
    const next = Math.min(
      ...[...snapshot.messages.map((m) => m.expiresAt), ...(files.data ?? []).map((f) => f.expiresAt)].filter(
        (expiry) => expiry > now,
      ),
    );
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        void meeting.refresh();
      },
      Math.max(1000, next - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [snapshot.messages, files.data, meeting, now]);
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['files', snapshot.id] });
  }, [revision, queryClient, snapshot.id]);
  useEffect(() => {
    if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot.messages, files.data, panel]);
  const people = snapshot.participants.filter((p) => !p.service);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const writable = !ended && self && self.status !== 'WAITING';
  const uploadBusy = ['uploading', 'paused'].includes(uploading.status);
  const timeline = [
    ...snapshot.messages
      .filter((m) => m.expiresAt > Date.now())
      .map((message) => ({
        kind: 'message' as const,
        id: message.id,
        at: message.createdAt,
        message,
      })),
    ...(files.data ?? [])
      .filter((f) => f.completedAt && f.expiresAt > Date.now())
      .map((file) => ({
        kind: 'file' as const,
        id: file.id,
        at: file.completedAt!,
        file,
      })),
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const run = async (type: Parameters<Meeting['command']>[0], targetId?: string) => {
    try {
      await meeting.command(type, undefined, targetId);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const attach = (file?: globalThis.File) => {
    if (file && writable && !uploadBusy) {
      nearBottom.current = true;
      void meeting.uploader.start(file);
    }
  };
  return (
    <aside className="side-panel" aria-label="Панель встречи">
      <div className="panel-heading">
        <h2>
          {panel === 'people' ? 'Участники' : panel === 'services' ? 'Боты и интеграции' : 'Чат и файлы'}
        </h2>
        <IconButton label="Закрыть панель" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      <Tabs.Root value={panel} onValueChange={(v) => setPanel(v as Panel)} className="panel-tabs-root">
        <Tabs.List className="panel-tabs" aria-label="Разделы встречи">
          <Tabs.Tab value="people">
            Люди <span>{people.length}</span>
          </Tabs.Tab>
          <Tabs.Tab value="chat">Чат и файлы</Tabs.Tab>
          <Tabs.Tab value="services">Интеграции</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="people" className="panel-body people-panel">
          <button className="button secondary full" onClick={onInvite}>
            <UserPlus size={18} /> Пригласить в комнату
          </button>
          <input
            type="search"
            aria-label="Найти участника"
            placeholder="Найти участника"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="panel-eyebrow">В ЭТОЙ ВСТРЕЧЕ · {people.length}</div>
          <div className="participant-list">
            {people
              .filter((p) => p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
              .map((p) => (
                <ParticipantMenu className="participant-row" key={p.id} meeting={meeting} person={p}>
                  <Avatar name={p.name} />
                  <div className="participant-info">
                    <strong>
                      {p.name}
                      {p.id === self?.id ? ' (Вы)' : ''}
                    </strong>
                    <small>
                      {p.status === 'WAITING'
                        ? 'Ожидает подтверждения'
                        : p.status === 'JOINING'
                          ? 'Подключается'
                          : p.status === 'RECOVERING'
                            ? 'Восстанавливает связь'
                            : p.owner
                              ? 'Организатор'
                              : 'Участник'}
                    </small>
                  </div>
                  {self?.owner && !p.owner ? (
                    <>
                      {p.status === 'WAITING' && (
                        <IconButton
                          label={'Разрешить вход: ' + p.name}
                          onClick={() => void run('participant.approve', p.id)}
                        >
                          <Check size={18} />
                        </IconButton>
                      )}
                      <IconButton
                        label={'Исключить: ' + p.name}
                        onClick={() => void run('participant.remove', p.id)}
                      >
                        <UserX size={17} />
                      </IconButton>
                    </>
                  ) : (
                    !tracks.some(
                      (t) => t.participantId === p.id && t.source === Track.Source.Microphone && !t.muted,
                    ) && <MicOff className="muted" size={16} />
                  )}
                </ParticipantMenu>
              ))}
          </div>
        </Tabs.Panel>
        <Tabs.Panel
          value="chat"
          className="chat-panel"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            attach(e.dataTransfer.files[0]);
          }}
        >
          <div className="retention-note">
            Сообщения и файлы исчезнут через час после встречи, максимум через сутки.
          </div>
          <input
            type="file"
            ref={fileInput}
            hidden
            aria-label="Прикрепить файл"
            onChange={(e) => {
              attach(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div
            className="messages"
            ref={scroll}
            onScroll={(e) => {
              const el = e.currentTarget;
              nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            aria-label="Сообщения и вложения"
            role="log"
            aria-live="polite"
          >
            {!timeline.length && (
              <div className="chat-empty">
                <span className="chat-empty-icon">
                  <Paperclip size={24} />
                </span>
                <strong>Всё рядом с разговором</strong>
                <p>
                  Напишите сообщение или прикрепите файл.
                  <br />
                  Сюда можно перетащить документ.
                </p>
              </div>
            )}
            {timeline.map((entry) =>
              entry.kind === 'message' ? (
                <div
                  className={'message ' + (entry.message.participantId === self?.id ? 'own' : '')}
                  key={entry.id}
                >
                  <div className="message-meta">
                    <strong>{entry.message.name}</strong>
                    <time dateTime={new Date(entry.at).toISOString()}>
                      {new Date(entry.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </time>
                  </div>
                  <p>{entry.message.text}</p>
                </div>
              ) : (
                <div className="attachment-message" key={entry.id}>
                  <div className="message-meta">
                    <strong>
                      {snapshot.participants.find((p) => p.id === entry.file.ownerId)?.name ?? 'Участник'}
                    </strong>
                    <time dateTime={new Date(entry.at).toISOString()}>
                      {new Date(entry.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </time>
                  </div>
                  <div className="file-row">
                    <span className="file-icon">
                      <File size={23} />
                    </span>
                    <div>
                      <strong title={entry.file.name}>{entry.file.name}</strong>
                      <small>{formatBytes(entry.file.size)} · временный файл</small>
                    </div>
                    <IconButton
                      label={'Скачать ' + entry.file.name}
                      onClick={() =>
                        void meeting.api.download(entry.file).catch((e) => setError((e as Error).message))
                      }
                    >
                      <Download size={18} />
                    </IconButton>
                  </div>
                </div>
              ),
            )}
            {files.data
              ?.filter((f) => !f.completedAt && f.expiresAt > Date.now() && f.name !== uploading.name)
              .map((file) => (
                <div className="file-row" key={file.id}>
                  <span className="file-icon">
                    <FileUp size={23} />
                  </span>
                  <div>
                    <strong>{file.name}</strong>
                    <small>Незавершённая загрузка</small>
                  </div>
                  <IconButton
                    label={'Удалить незавершённую загрузку: ' + file.name}
                    onClick={() =>
                      void meeting.api
                        .cancel(file.id)
                        .then(() => queryClient.invalidateQueries({ queryKey: ['files', snapshot.id] }))
                        .catch((e) => setError((e as Error).message))
                    }
                  >
                    <X size={18} />
                  </IconButton>
                </div>
              ))}
            {files.isError && (
              <p className="form-error">Не удалось получить вложения. Сообщения остаются доступны.</p>
            )}
          </div>
          {uploading.status !== 'idle' && (
            <div className="upload-progress">
              <strong>{uploading.name}</strong>
              <progress value={uploading.progress} max={1} aria-label="Прогресс загрузки" />
              <div>
                <span>
                  {uploading.status === 'paused'
                    ? 'Приостановлено'
                    : uploading.status === 'done'
                      ? 'Загружено'
                      : uploading.status === 'error'
                        ? 'Ошибка загрузки'
                        : Math.round(uploading.progress * 100) + '%'}
                </span>
                {uploading.status === 'uploading' ? (
                  <IconButton label="Приостановить загрузку" onClick={() => void meeting.uploader.pause()}>
                    <Pause size={17} />
                  </IconButton>
                ) : (
                  ['paused', 'error'].includes(uploading.status) && (
                    <IconButton
                      label="Продолжить загрузку"
                      disabled={!writable}
                      onClick={() => meeting.uploader.resume()}
                    >
                      <Play size={17} />
                    </IconButton>
                  )
                )}
                <IconButton
                  label={uploading.status === 'done' ? 'Скрыть завершённую загрузку' : 'Отменить загрузку'}
                  onClick={() => void meeting.uploader.cancel()}
                >
                  <X size={17} />
                </IconButton>
              </div>
              {uploading.error && <p className="form-error">{uploading.error}</p>}
            </div>
          )}
          <form
            className="message-composer"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!draft.trim() || sending || !writable) return;
              setSending(true);
              setError('');
              try {
                await meeting.command('message.send', draft);
                setDraft('');
                nearBottom.current = true;
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSending(false);
              }
            }}
          >
            <textarea
              aria-label="Сообщение"
              placeholder={ended ? 'Встреча завершена' : 'Написать сообщение…'}
              rows={2}
              maxLength={4000}
              value={draft}
              disabled={!writable}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="composer-actions">
              <IconButton
                label="Прикрепить файл"
                disabled={!writable || uploadBusy}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={19} />
              </IconButton>
              <small>до 100 МиБ</small>
              <IconButton
                label="Отправить сообщение"
                type="submit"
                className="send-button"
                disabled={!draft.trim() || sending || !writable}
              >
                <Send size={18} />
              </IconButton>
            </div>
          </form>
        </Tabs.Panel>
        <Tabs.Panel value="services" className="panel-body service-body">
          <Services meeting={meeting} />
        </Tabs.Panel>
      </Tabs.Root>
      {error && (
        <p role="alert" className="form-error panel-error">
          {error}
        </p>
      )}
    </aside>
  );
}
