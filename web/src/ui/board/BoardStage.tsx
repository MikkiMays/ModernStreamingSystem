// Путь шрифтов — раньше Excalidraw: тот читает его, когда заводит шрифты.
import './asset-path';
import '@excalidraw/excalidraw/index.css';
import './board.css';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  FONT_FAMILY,
  loadFromBlob,
  MainMenu,
  ROUNDNESS,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import {
  Download,
  FileImage,
  FileJson,
  FolderOpen,
  Highlighter,
  MessageSquarePlus,
  MoreHorizontal,
  PenLine,
  Presentation,
  StickyNote,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BoardView } from '../../api/types';
import type { Meeting } from '../../core/meeting';
import { allowed, type RoomAction } from '../../core/permissions';
import {
  BOARD_EXTENSION,
  boardFileKind,
  boardStamp,
  centerAt,
  remapIds,
  visible,
} from '../../core/board/export';
import { BoardFiles } from '../../core/board/files';
import type { BoardElement } from '../../core/board/protocol';
import { BoardSync, type BoardNotice, type BoardState } from '../../core/board/sync';
import { locale, type Translate } from '../../i18n';
import { IntegrationBarSlot, StageExitButton } from '../IntegrationBar';
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  useToast,
} from '../kit';
import { useStore } from '../primitives';
import { ExcalidrawCanvas, type BoardPerson } from './excalidraw-canvas';
import { guardLinks } from './hardening';
import { boardJson, boardPng, boardSvg, hasContent, saveFile } from './images';
import { excalidrawLanguage } from './lang';
import { useShade } from './theme';

/**
 * Доска встречи (R159): Excalidraw на сцене, рисуют все сразу — или только ведущий.
 *
 * Своё рисуется сразу, соседям уходит по кадру (`core/board/sync.ts`), их курсоры и лазер — с именами и
 * цветами. Свои действия — в шапке, как у столов игр: «Маркер» и «Стикер» одной кнопкой, «Сохранить в
 * чат» (картинка и файл доски одним сообщением — R154, как в Телемосте), «Скачать», «Открыть файл»,
 * кто рисует, «Очистить». Меню Excalidraw — только пункты Cord: ни ссылок на GitHub, ни библиотек, ни
 * встраиваемых страниц (`hardening.ts`).
 */
export default function BoardStage({ meeting }: { meeting: Meeting }) {
  const snapshot = useStore(meeting.snapshot);
  const board = snapshot.board;
  if (!board) return null;
  // Открыли заново — новая доска на сцене: и сокет, и холст начинаются с нуля.
  return <BoardSurface key={board.openedAt} meeting={meeting} board={board} />;
}

/** Цвета курсоров соседей — различимые на светлом и тёмном холсте. */
const CURSORS = ['#4c6ef5', '#e8590c', '#2b9459', '#c2255c', '#7048e8', '#0c8599', '#e67700', '#5f3dc4'];
/** Маркер — широкий жёлтый на 40 % прозрачности; стикер — бледно-жёлтый квадрат. */
const HIGHLIGHT = '#fab005';
const STICKY = '#fff3bf';

function cursorColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return CURSORS[Math.abs(hash) % CURSORS.length]!;
}

interface PendingImport {
  name: string;
  elements: BoardElement[];
  files: BinaryFileData[];
}

function BoardSurface({ meeting, board }: { meeting: Meeting; board: BoardView }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const shade = useShade();
  const snapshot = useStore(meeting.snapshot);
  const me = meeting.admission.participantId;
  const may = (action: RoomAction) => allowed(snapshot, me, action);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [sync, setSync] = useState<BoardSync | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [confirm, setConfirm] = useState<'close' | 'clear' | null>(null);
  const [drop, setDrop] = useState(false);
  const [highlighter, setHighlighter] = useState<null | {
    color: string;
    opacity: number;
    width: number;
  }>(null);
  const picker = useRef<HTMLInputElement>(null);
  const highlighterRef = useRef(highlighter);
  highlighterRef.current = highlighter;
  // Имена и цвета соседей — из снимка встречи; холст спрашивает их на каждый кадр курсоров.
  const people = useRef<ReadonlyMap<string, BoardPerson>>(new Map());
  people.current = useMemo(
    () =>
      new Map(snapshot.participants.map((p) => [p.id, { name: p.name, color: cursorColor(p.id) }] as const)),
    [snapshot.participants],
  );

  const state: BoardState = useStore(sync?.state ?? IDLE.state);
  const live = useStore(sync?.canDraw ?? IDLE.canDraw);
  const peers = useStore(sync?.peers ?? IDLE.peers);
  const notice = useStore(sync?.notice ?? IDLE.notice);
  const role = may('board.draw');
  // Рисовать — когда это разрешает снимок встречи, а сокет доски не сказал «нет» (он узнаёт о смене раньше).
  const canDraw = role && live !== false;

  // Синхронизация рождается вместе с холстом и умирает вместе с ним.
  useEffect(() => {
    if (!api) return;
    const canvas = new ExcalidrawCanvas(api, () => people.current);
    const files = new BoardFiles({ put: meeting.api.putBoardFile, get: meeting.api.boardFile }, canvas);
    const next = new BoardSync({
      roomId: meeting.admission.roomId,
      credential: meeting.admission.credential,
      canvas,
      files,
      now: () => meeting.serverNow(),
    });
    next.start();
    setSync(next);
    const stop = next.stats.subscribe(() => meeting.boardLatency.set(next.stats.get()));
    return () => {
      stop();
      next.dispose();
      files.dispose();
      setSync(null);
    };
  }, [api, meeting]);

  // Ни одной ссылки наружу, пока доска на сцене; язык страницы — как был до Excalidraw.
  useEffect(() => {
    const lang = document.documentElement.lang;
    const stop = guardLinks(document);
    return () => {
      stop();
      document.documentElement.lang = lang;
      meeting.boardLatency.set(null);
    };
  }, [meeting]);

  useEffect(() => {
    if (!notice) return;
    const who = (id: string) => snapshot.participants.find((p) => p.id === id)?.name ?? '';
    toast.add({ title: noticeText(t, notice, who), type: notice.kind === 'cleared' ? 'info' : 'danger' });
    // Тост — один на событие: следующее придёт новым объектом.
  }, [notice]);

  const stem = () => boardStamp(new Date(), locale(t));

  /** «Сохранить в чат»: картинка и файл доски — одним сообщением «Доска · 14:20» (R154). */
  const saveToChat = async () => {
    if (!api || saving) return false;
    if (!hasContent(api)) {
      toast.add({ title: t(($) => $.board.chat.empty) });
      return false;
    }
    setSaving(true);
    try {
      const { time, file } = stem();
      const name = t(($) => $.board.chat.file, { time: file });
      const png = new File([await boardPng(api, shade)], `${name}.png`, { type: 'image/png' });
      const doc = new File([boardJson(api)], `${name}${BOARD_EXTENSION}`, { type: 'application/json' });
      if (!(await meeting.uploader.send(png)) || !(await meeting.uploader.send(doc)))
        throw new Error(t(($) => $.board.chat.failed));
      await meeting.command(
        'message.send',
        t(($) => $.board.chat.message, { time }),
      );
      toast.add({
        title: t(($) => $.board.chat.saved),
        description: t(($) => $.board.chat.retention),
        type: 'success',
      });
      return true;
    } catch (error) {
      toast.add({
        title: t(($) => $.board.chat.failed),
        description: (error as Error).message,
        type: 'danger',
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const download = async (kind: 'png' | 'svg' | 'board') => {
    if (!api) return;
    const name = t(($) => $.board.chat.file, { time: stem().file });
    try {
      if (kind === 'board') saveFile(boardJson(api), `${name}${BOARD_EXTENSION}`);
      else if (kind === 'png') saveFile(await boardPng(api, shade), `${name}.png`);
      else saveFile(await boardSvg(api, shade), `${name}.svg`);
    } catch {
      toast.add({ title: t(($) => $.board.exportFailed), type: 'danger' });
    }
  };

  /** Файл доски — разобрать и спросить, заменить доску или добавить на неё. */
  const openFile = useCallback(
    async (file: File) => {
      try {
        const scene = await loadFromBlob(file, null, null);
        const elements = visible(scene.elements as unknown as BoardElement[]);
        if (!elements.length) throw new Error('empty');
        setPending({ name: file.name, elements, files: Object.values(scene.files ?? {}) });
      } catch {
        toast.add({ title: t(($) => $.board.import.failed), type: 'danger' });
      }
    },
    [t, toast],
  );

  // «Открыть на доске» из чата (R154): файл ждёт в встрече, пока доска не на сцене.
  const incoming = useStore(meeting.boardImport);
  useEffect(() => {
    if (!incoming || !api) return;
    meeting.boardImport.set(null);
    void openFile(incoming);
  }, [incoming, api, meeting, openFile]);

  const apply = async (mode: 'replace' | 'add') => {
    const job = pending;
    setPending(null);
    if (!api || !sync || !job) return;
    try {
      if (job.files.length) api.addFiles(job.files);
      let elements = remapIds(job.elements);
      if (mode === 'replace') {
        const before = sync.epoch;
        await meeting.command('board.clear');
        // Очистка доходит сокетом доски: своё — после неё, иначе оно ушло бы в старое поколение.
        for (let waited = 0; sync.epoch === before && waited < 4000; waited += 50)
          await new Promise((resolve) => setTimeout(resolve, 50));
      } else {
        const view = api.getAppState();
        const center = viewportCoordsToSceneCoords(
          { clientX: view.offsetLeft + view.width / 2, clientY: view.offsetTop + view.height / 2 },
          view,
        );
        elements = centerAt(elements, center.x, center.y);
      }
      const next = [
        ...api.getSceneElementsIncludingDeleted(),
        ...(elements as unknown as ExcalidrawElement[]),
      ];
      api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      api.scrollToContent(elements as unknown as ExcalidrawElement[], { fitToContent: true, animate: true });
      sync.localChange();
    } catch (error) {
      toast.add({
        title: t(($) => $.board.import.failed),
        description: (error as Error).message,
        type: 'danger',
      });
    }
  };

  /** Маркер: перо пошире, жёлтое, на 40 % прозрачности; другой инструмент — прежнее перо. */
  const toggleHighlighter = () => {
    if (!api) return;
    const app = api.getAppState();
    if (highlighter) {
      restorePen(api, highlighter);
      setHighlighter(null);
      return;
    }
    setHighlighter({
      color: app.currentItemStrokeColor,
      opacity: app.currentItemOpacity,
      width: app.currentItemStrokeWidth,
    });
    api.setActiveTool({ type: 'freedraw' });
    api.updateScene({
      appState: { currentItemStrokeColor: HIGHLIGHT, currentItemOpacity: 40, currentItemStrokeWidth: 6 },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };

  /** Стикер: квадрат 200×200 бледно-жёлтый, со скруглением, — посреди того, что видно. */
  const addSticky = () => {
    if (!api) return;
    const view = api.getAppState();
    const center = viewportCoordsToSceneCoords(
      { clientX: view.offsetLeft + view.width / 2, clientY: view.offsetTop + view.height / 2 },
      view,
    );
    const [note] = convertToExcalidrawElements([
      {
        type: 'rectangle',
        x: center.x - 100,
        y: center.y - 100,
        width: 200,
        height: 200,
        backgroundColor: STICKY,
        strokeColor: '#e6b800',
        fillStyle: 'solid',
        roughness: 0,
        roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
      },
    ]);
    if (!note) return;
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), note],
      appState: { selectedElementIds: { [note.id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    api.setActiveTool({ type: 'selection' });
    toast.add({ title: t(($) => $.board.stickyHint) });
  };

  const run = (type: 'board.close' | 'board.clear' | 'board.settings', option?: string) =>
    meeting
      .command(type, undefined, undefined, option ? { option } : undefined)
      .catch((error) => toast.add({ title: (error as Error).message, type: 'danger' }));

  /** Закрыть доску: есть нарисованное — сначала спросить, сохранить ли его в чат (R154). */
  const requestClose = () => {
    if (api && hasContent(api)) setConfirm('close');
    else void run('board.close');
  };

  const onChange = (_elements: readonly unknown[], app: AppState) => {
    sync?.localChange();
    sync?.select(Object.keys(app.selectedElementIds).filter((id) => app.selectedElementIds[id]));
    const pen = highlighterRef.current;
    if (pen && api && app.activeTool.type !== 'freedraw') {
      restorePen(api, pen);
      setHighlighter(null);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDrop(false);
    const file = event.dataTransfer?.files?.[0];
    // Сцену из файла открывает Cord — с вопросом и для всех; картинки кладёт сам Excalidraw.
    if (!file || boardFileKind(file.name) !== 'board') return;
    event.preventDefault();
    event.stopPropagation();
    if (canDraw) void openFile(file);
  };

  const viewOnly = !role;
  const mode = board.drawers === 'host' ? t(($) => $.board.modes.host) : t(($) => $.board.modes.all);
  const canClear = may('board.clear');
  const canSettings = may('board.settings');
  const status = statusText(t, state);
  const others = [...peers].filter((id) => id !== me).length;

  return (
    <section className="board" aria-label={t(($) => $.board.name)} data-view-only={viewOnly || undefined}>
      <header className="board-bar">
        <div className="board-bar__title">
          <span className="board-bar__mark" aria-hidden="true">
            <Presentation size={20} />
          </span>
          <div className="board-bar__heading">
            <h2>{t(($) => $.board.name)}</h2>
            <span className="board-bar__mode">
              {viewOnly ? <Users size={14} aria-hidden="true" /> : <PenLine size={14} aria-hidden="true" />}
              {mode}
              {others > 0 && <span className="board-bar__peers"> · {others + 1}</span>}
            </span>
          </div>
        </div>
        {canDraw && (
          <div className="board-bar__tools" role="group" aria-label={t(($) => $.board.actions.menu)}>
            <Button
              size="sm"
              variant="quiet"
              icon={<Highlighter />}
              aria-pressed={!!highlighter}
              disabled={!api}
              onClick={toggleHighlighter}
            >
              {t(($) => $.board.actions.highlighter)}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              icon={<StickyNote />}
              title={t(($) => $.board.stickyHint)}
              disabled={!api}
              onClick={addSticky}
            >
              {t(($) => $.board.actions.sticky)}
            </Button>
          </div>
        )}
        <div className="board-bar__actions">
          {/* Музыка во встрече — мини-плеером в шапке доски (R128). */}
          <IntegrationBarSlot />
          {/* Людей у доски не видно — выход к ним (R121). */}
          <StageExitButton variant="bar" />
          <Button
            size="sm"
            className="board-bar__save"
            icon={<MessageSquarePlus />}
            loading={saving}
            disabled={!api}
            onClick={() => void saveToChat()}
          >
            {t(($) => $.board.actions.saveToChat)}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <IconButton label={t(($) => $.board.actions.more)} disabled={!api}>
                  <MoreHorizontal size={20} />
                </IconButton>
              }
            />
            <MenuContent align="end" className="board-menu">
              <MenuLabel>{t(($) => $.board.actions.download)}</MenuLabel>
              <MenuItem icon={<FileImage />} onClick={() => void download('png')}>
                {t(($) => $.board.actions.downloadPng)}
              </MenuItem>
              <MenuItem icon={<Download />} onClick={() => void download('svg')}>
                {t(($) => $.board.actions.downloadSvg)}
              </MenuItem>
              <MenuItem icon={<FileJson />} onClick={() => void download('board')}>
                {t(($) => $.board.actions.downloadFile)}
              </MenuItem>
              {canDraw && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<FolderOpen />} onClick={() => picker.current?.click()}>
                    {t(($) => $.board.actions.open)}
                  </MenuItem>
                </>
              )}
              {canSettings && (
                <>
                  <MenuSeparator />
                  <MenuLabel>{t(($) => $.board.actions.drawers)}</MenuLabel>
                  <MenuRadioGroup
                    value={board.drawers}
                    onValueChange={(value) => void run('board.settings', String(value))}
                  >
                    <MenuRadioItem className="ui-menu__item" value="all">
                      <span className="ui-menu__icon" aria-hidden="true">
                        <Users />
                      </span>
                      <span className="ui-menu__label">{t(($) => $.board.actions.drawersAll)}</span>
                    </MenuRadioItem>
                    <MenuRadioItem className="ui-menu__item" value="host">
                      <span className="ui-menu__icon" aria-hidden="true">
                        <PenLine />
                      </span>
                      <span className="ui-menu__label">{t(($) => $.board.actions.drawersHost)}</span>
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </>
              )}
              {canClear && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 />} destructive onClick={() => setConfirm('clear')}>
                    {t(($) => $.board.actions.clear)}
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
          {may('board.close') && (
            <IconButton label={t(($) => $.board.actions.close)} onClick={requestClose}>
              <X size={20} />
            </IconButton>
          )}
        </div>
      </header>
      {viewOnly && (
        <p className="board-note" role="status">
          {t(($) => $.board.viewOnly)}
        </p>
      )}
      {status && (
        <p className="board-note board-note--status" role="status" data-state={state}>
          {status}
          {state === 'replaced' && (
            <Button size="sm" variant="quiet" onClick={() => sync?.reconnect()}>
              {t(($) => $.board.status.reconnect)}
            </Button>
          )}
        </p>
      )}
      <div
        className="board-canvas"
        data-drop={drop || undefined}
        onDragOverCapture={(event) => {
          if (canDraw && [...(event.dataTransfer?.items ?? [])].some((item) => item.kind === 'file'))
            setDrop(true);
        }}
        onDragLeave={() => setDrop(false)}
        onDropCapture={onDrop}
      >
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={INITIAL}
          theme={shade}
          langCode={excalidrawLanguage(i18n.language)}
          viewModeEnabled={!canDraw}
          isCollaborating
          autoFocus={false}
          handleKeyboardGlobally={false}
          validateEmbeddable={() => false}
          aiEnabled={false}
          UIOptions={UI_OPTIONS}
          onChange={onChange}
          onPointerUpdate={({ pointer, button }) => sync?.pointer(pointer.x, pointer.y, pointer.tool, button)}
        >
          <MainMenu>
            <MainMenu.Item icon={<MessageSquarePlus />} onSelect={() => void saveToChat()}>
              {t(($) => $.board.actions.saveToChat)}
            </MainMenu.Item>
            <MainMenu.Item icon={<FileImage />} onSelect={() => void download('png')}>
              {t(($) => $.board.actions.download)} · PNG
            </MainMenu.Item>
            <MainMenu.Item icon={<Download />} onSelect={() => void download('svg')}>
              {t(($) => $.board.actions.download)} · SVG
            </MainMenu.Item>
            <MainMenu.Item icon={<FileJson />} onSelect={() => void download('board')}>
              {t(($) => $.board.actions.downloadFile)}
            </MainMenu.Item>
            {canDraw && (
              <MainMenu.Item icon={<FolderOpen />} onSelect={() => picker.current?.click()}>
                {t(($) => $.board.actions.open)}
              </MainMenu.Item>
            )}
            {canClear && (
              <MainMenu.Item icon={<Trash2 />} onSelect={() => setConfirm('clear')}>
                {t(($) => $.board.actions.clear)}
              </MainMenu.Item>
            )}
            <MainMenu.Separator />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        </Excalidraw>
        {drop && (
          <div className="board-drop" aria-hidden="true">
            {t(($) => $.board.drop)}
          </div>
        )}
      </div>
      <input
        ref={picker}
        type="file"
        hidden
        accept={`${BOARD_EXTENSION},.excalidraw,.json,application/json,image/png`}
        aria-label={t(($) => $.board.actions.open)}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void openFile(file);
        }}
      />
      <Dialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
        title={t(($) => $.board.import.title)}
        size="sm"
        description={pending ? t(($) => $.board.import.description, { name: pending.name }) : undefined}
        footer={
          <>
            <Button variant="quiet" onClick={() => setPending(null)}>
              {t(($) => $.board.cancel)}
            </Button>
            <Button
              variant="secondary"
              disabled={!canClear}
              title={canClear ? t(($) => $.board.import.replaceHint) : t(($) => $.board.import.noReplace)}
              onClick={() => void apply('replace')}
            >
              {t(($) => $.board.import.replace)}
            </Button>
            <Button variant="primary" onClick={() => void apply('add')}>
              {t(($) => $.board.import.add)}
            </Button>
          </>
        }
      >
        <p className="board-dialog-note">
          {canClear ? t(($) => $.board.import.replaceHint) : t(($) => $.board.import.noReplace)}
        </p>
      </Dialog>
      <Dialog
        open={confirm === 'close'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t(($) => $.board.close.title)}
        size="sm"
        description={t(($) => $.board.close.description)}
        footer={
          <>
            <Button
              variant="quiet"
              onClick={() => {
                setConfirm(null);
                void run('board.close');
              }}
            >
              {t(($) => $.board.close.discard)}
            </Button>
            <Button
              variant="primary"
              loading={saving}
              autoFocus
              onClick={() =>
                void saveToChat().then((saved) => {
                  if (!saved) return;
                  setConfirm(null);
                  void run('board.close');
                })
              }
            >
              {t(($) => $.board.close.save)}
            </Button>
          </>
        }
      >
        <p className="board-dialog-note">{t(($) => $.board.chat.retention)}</p>
      </Dialog>
      <Dialog
        open={confirm === 'clear'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t(($) => $.board.clear.title)}
        size="sm"
        description={t(($) => $.board.clear.description)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirm(null)}>
              {t(($) => $.board.cancel)}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(null);
                void run('board.clear');
              }}
            >
              {t(($) => $.board.clear.confirm)}
            </Button>
          </>
        }
      />
    </section>
  );
}

/** Пока синхронизации нет (холст ещё рождается) — пустые хранилища того же вида. */
const IDLE = new BoardSync({
  roomId: '',
  credential: '',
  canvas: {
    elements: () => [],
    editing: () => new Set(),
    drawing: () => null,
    merge: () => {},
    replace: () => {},
    ink: () => {},
    cursors: () => {},
  },
  now: () => 0,
});

/** Как Cord рисует по умолчанию: «аккуратно» (без дрожи), обычным шрифтом, тёмной линией. */
const INITIAL = {
  appState: {
    currentItemRoughness: 0,
    currentItemFontFamily: FONT_FAMILY.Nunito,
    currentItemStrokeColor: '#1e1e1e',
    currentItemStrokeWidth: 2,
    viewBackgroundColor: '#ffffff',
  },
  elements: [],
};

/**
 * Что редактору нельзя: открывать и сохранять файлы своим путём (у Cord свои «Открыть файл» и
 * «Скачать» — с вопросом и для всех), чистить холст мимо команды доски, переключать тему (она — Cord).
 */
const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false as const,
    loadScene: false,
    saveToActiveFile: false,
    toggleTheme: null,
    saveAsImage: false,
  },
  tools: { image: true },
};

function restorePen(api: ExcalidrawImperativeAPI, pen: { color: string; opacity: number; width: number }) {
  api.updateScene({
    appState: {
      currentItemStrokeColor: pen.color,
      currentItemOpacity: pen.opacity,
      currentItemStrokeWidth: pen.width,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

function statusText(t: Translate, state: BoardState): string | null {
  switch (state) {
    case 'connecting':
      return t(($) => $.board.status.connecting);
    case 'offline':
      return t(($) => $.board.status.offline);
    case 'closed':
      return t(($) => $.board.status.closed);
    case 'replaced':
      return t(($) => $.board.status.replaced);
    default:
      return null;
  }
}

function noticeText(t: Translate, notice: BoardNotice, who: (id: string) => string): string {
  if (notice.kind === 'full') return t(($) => $.board.notice.full);
  if (notice.kind === 'rejected') return t(($) => $.board.notice.rejected);
  return t(($) => $.board.notice.cleared, { name: who(notice.by) });
}
