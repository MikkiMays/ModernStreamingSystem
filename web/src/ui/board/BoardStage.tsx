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
  getVisibleSceneBounds,
  hashElementsVersion,
  loadFromBlob,
  MainMenu,
  newElementWith,
  ROUNDNESS,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import {
  Clock3,
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
import { fixLink, linkTarget, type LinkFix } from '../../core/board/links';
import type { BoardElement } from '../../core/board/protocol';
import { BoardSync, type BoardNotice, type BoardState } from '../../core/board/sync';
import { locale, type Translate } from '../../i18n';
import { IntegrationBarSlot, StageExitButton } from '../IntegrationBar';
import { useStageExit } from '../stage-context';
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  useToast,
} from '../kit';
import { useStore } from '../primitives';
import { CursorLayer, type BoardPerson } from './cursors';
import { ExcalidrawCanvas, viewOf } from './excalidraw-canvas';
import { guardGaps } from './gaps';
import { guardLinks } from './hardening';
import { boardJson, boardPng, boardSvg, hasContent, saveFile } from './images';
import { excalidrawLanguage } from './lang';
import { Minimap } from './Minimap';
import { barAnchor, menuAnchor, MenuTool, ToolSlot, ToolToggle } from './tools';
import { failureDetail, failureText, FriendlyError } from '../../core/failure';

/**
 * Доска встречи (R159): Excalidraw на сцене, рисуют все сразу — или только ведущий.
 *
 * Своё рисуется сразу, соседям уходит по кадру (`core/board/sync.ts`); их курсоры — только стрелкой
 * своего цвета (R168, `cursors.ts`), лазер — их цветом. «Маркер» и «Стикер» — в колонке инструментов
 * Excalidraw (R174, `tools.tsx`), справа внизу — мини-карта (R169). Свои действия — в шапке, как у столов
 * игр: «Сохранить в чат» (картинка и файл доски одним сообщением — R154, как в Телемосте), «Скачать»,
 * «Открыть файл», кто рисует, «Очистить». Меню Excalidraw — только пункты Cord: ни ссылок на GitHub, ни
 * библиотек, ни встраиваемых страниц (`hardening.ts`); ссылка на элементе — только на сайт, не на объект
 * доски (R176).
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
/** Стикер — свой инструмент Excalidraw (`activeTool.type: 'custom'`): нажатие по доске ставит его туда. */
const STICKY_TOOL = 'cord-sticky';

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
  const snapshot = useStore(meeting.snapshot);
  const me = meeting.admission.participantId;
  const may = (action: RoomAction) => allowed(snapshot, me, action);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [sync, setSync] = useState<BoardSync | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [confirm, setConfirm] = useState<'close' | 'clear' | null>(null);
  const [drop, setDrop] = useState(false);
  const [stickyArmed, setStickyArmed] = useState(false);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const { away } = useStageExit();
  const [highlighter, setHighlighter] = useState<null | {
    color: string;
    opacity: number;
    width: number;
  }>(null);
  const picker = useRef<HTMLInputElement>(null);
  const section = useRef<HTMLElement>(null);
  const cursorRoot = useRef<HTMLDivElement>(null);
  const cursorLayer = useRef<CursorLayer | null>(null);
  /** Сцена, в которой уже проверяли ссылки (R176), — по отпечатку версий. */
  const linksChecked = useRef(-1);
  const marking = useRef(0);
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
    const layer = cursorRoot.current ? new CursorLayer(cursorRoot.current, () => people.current) : null;
    cursorLayer.current = layer;
    layer?.move(viewOf(api.getAppState()));
    const canvas = new ExcalidrawCanvas(api, () => people.current, layer);
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
    const stop = next.stats.subscribe(() => {
      const stats = next.stats.get();
      meeting.boardLatency.set(stats);
      if (section.current && stats) section.current.dataset.latency = String(stats.p95);
    });
    return () => {
      stop();
      next.dispose();
      files.dispose();
      layer?.dispose();
      cursorLayer.current = null;
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

  // Строки Excalidraw, которых нет в его переводах, — на языке человека (`gaps.ts`).
  const gaps = useMemo(
    () =>
      new Map<string, string>(
        i18n.language === 'en'
          ? []
          : [
              ['Type or paste your link here', t(($) => $.board.excalidraw.linkHint)],
              ['No link is set', t(($) => $.board.excalidraw.linkEmpty)],
              ['Wrap selection in frame', t(($) => $.board.excalidraw.wrapInFrame)],
              ['Frame tool', t(($) => $.board.excalidraw.frameTool)],
            ],
      ),
    [t, i18n.language],
  );
  useEffect(() => guardGaps(document, gaps), [gaps]);

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
      const png = new File([await boardPng(api)], `${name}.png`, { type: 'image/png' });
      const doc = new File([boardJson(api)], `${name}${BOARD_EXTENSION}`, { type: 'application/json' });
      if (!(await meeting.uploader.send(png)) || !(await meeting.uploader.send(doc)))
        throw new FriendlyError(t(($) => $.board.chat.failed));
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
      const why = failureDetail(error, 'board');
      toast.add({
        title: t(($) => $.board.chat.failed),
        description: why === t(($) => $.board.chat.failed) ? undefined : why,
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
      else if (kind === 'png') saveFile(await boardPng(api), `${name}.png`);
      else saveFile(await boardSvg(api), `${name}.svg`);
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
        description: failureDetail(error, 'board'),
        type: 'danger',
      });
    }
  };

  /** Маркер: перо пошире, жёлтое, на 40 % прозрачности; выключить или взять другой инструмент — прежнее перо. */
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

  /**
   * Стикер — инструмент, как фигуры Excalidraw (R174): выбрал — нажал по доске — стикер там и сразу
   * пишется. С клавиатуры нажать по доске нечем — стикер встаёт посреди вида.
   */
  const toggleSticky = (keyboard: boolean) => {
    if (!api) return;
    if (highlighter) {
      restorePen(api, highlighter);
      setHighlighter(null);
    }
    if (keyboard) addSticky();
    else if (stickyArmed) api.setActiveTool({ type: 'selection' });
    else api.setActiveTool({ type: 'custom', customType: STICKY_TOOL });
  };

  /**
   * Стикер: квадрат 200×200 бледно-жёлтый, со скруглением, — в точке `at` сцены или посреди того, что
   * видно. Инструмент закреплён замком — остаётся стикером; иначе — выделение и сразу набор текста.
   */
  const addSticky = (at?: { x: number; y: number }, locked = false) => {
    if (!api) return;
    const view = api.getAppState();
    const center =
      at ??
      viewportCoordsToSceneCoords(
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
    if (locked) return;
    api.setActiveTool({ type: 'selection' });
    startTyping(note.id);
  };

  /**
   * Набор текста в только что поставленном стикере — тем же Enter, которым Excalidraw начинает текст в
   * выбранной фигуре (своего вызова для этого у него нет). Не вышло — подсказка, как писать.
   */
  const startTyping = (id: string) => {
    requestAnimationFrame(() => {
      canvasEl
        ?.querySelector('.excalidraw')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      requestAnimationFrame(() => {
        const text = api?.getAppState().editingTextElement;
        if (!text || !('containerId' in text) || text.containerId !== id)
          toast.add({ title: t(($) => $.board.stickyHint) });
      });
    });
  };
  const addStickyRef = useRef(addSticky);
  addStickyRef.current = addSticky;

  /*
    Сменился размер холста (окно, телефон ↔ компьютер): Excalidraw узнаёт о нём сразу, а раскладку меняет
    только со следующим своим обновлением — до него телефонная полоса висела бы на широком экране (и
    наоборот), а с ней и маркер со стикером. `refresh()` — это обновление.
  */
  useEffect(() => {
    if (!api || !canvasEl || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => api.refresh());
    });
    observer.observe(canvasEl);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [api, canvasEl]);

  // Инструмент «Стикер»: отпустили палец или кнопку на доске — стикер там, где нажали.
  useEffect(() => {
    if (!api) return;
    return api.onPointerUp((tool, down) => {
      if (tool.type === 'custom' && tool.customType === STICKY_TOOL)
        addStickyRef.current({ x: down.origin.x, y: down.origin.y }, tool.locked);
    });
  }, [api]);

  // Ушёл к участникам (R121, R175): окна и меню редактора закрываются — они в портале у `body`, и слой
  // доски их не спрячет; свои окна доски — тоже.
  useEffect(() => {
    if (!away || !api) return;
    api.updateScene({
      appState: {
        openDialog: null,
        openMenu: null,
        openPopup: null,
        contextMenu: null,
        showHyperlinkPopup: false,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setConfirm(null);
    setPending(null);
  }, [away, api]);

  /** Ссылка на элементе (R176): сайт — в новой вкладке; на объект доски и прочее — никуда. */
  const openLink = (element: NonDeletedExcalidrawElement, event: CustomEvent) => {
    event.preventDefault();
    const target = linkTarget(element.link, location.href);
    if (target.kind === 'web') window.open(target.href, '_blank', 'noopener,noreferrer');
  };

  /**
   * Ссылок на объекты доски не бывает (R176): пункты и кнопки Excalidraw спрятаны (`board.css`), а та, что
   * пришла иначе — вставкой адреса в поле ссылки, из файла, от старой доски, — снимается с элемента. Сайт
   * без схемы («example.org») дописывается до https: иначе ядро отвергло бы правку целиком
   * (`core/board/links.ts`). Правит тот, кто может рисовать; у своего выбранного — тост почему.
   */
  const fixLinks = (elements: readonly ExcalidrawElement[], app: AppState) => {
    if (!api) return;
    const version = hashElementsVersion(elements);
    if (version === linksChecked.current) return;
    linksChecked.current = version;
    const here = location.href;
    const fixes = new Map<string, LinkFix>();
    for (const el of elements) {
      const fix = el.isDeleted ? null : fixLink(el.link, here);
      if (fix) fixes.set(el.id, fix);
    }
    if (!fixes.size) return;
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((el) => {
        const fix = fixes.get(el.id);
        return fix ? newElementWith(el, { link: fix.link }) : el;
      }),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const mine = [...fixes].filter(([id]) => app.selectedElementIds[id]).map(([, fix]) => fix.reason);
    if (mine.includes('object')) toast.add({ title: t(($) => $.board.objectLink) });
    else if (mine.includes('unsupported')) toast.add({ title: t(($) => $.board.badLink) });
  };

  const run = (type: 'board.close' | 'board.clear' | 'board.settings', option?: string) =>
    meeting
      .command(type, undefined, undefined, option ? { option } : undefined)
      .catch((error) => toast.add({ title: failureText(error, 'board'), type: 'danger' }));

  /** Закрыть доску: есть нарисованное — сначала спросить, сохранить ли его в чат (R154). */
  const requestClose = () => {
    if (api && hasContent(api)) setConfirm('close');
    else void run('board.close');
  };

  /**
   * Сколько видимых элементов и их отпечаток — атрибутами секции, раз в кадр. По ним видно, что сцены
   * у участников сошлись (e2e), не заглядывая в холст.
   */
  const markScene = () => {
    if (marking.current) return;
    marking.current = requestAnimationFrame(() => {
      marking.current = 0;
      if (!api || !section.current) return;
      const shown = visible(api.getSceneElements() as unknown as BoardElement[]);
      section.current.dataset.elements = String(shown.length);
      section.current.dataset.scene = sceneMark(shown);
    });
  };

  const onChange = (elements: readonly ExcalidrawElement[], app: AppState) => {
    sync?.localChange();
    markScene();
    cursorLayer.current?.move(viewOf(app));
    // Что видно у себя — для тех, кто «следует» за этим участником.
    const view = getVisibleSceneBounds(app);
    sync?.viewport([view[0], view[1], view[2], view[3]]);
    const pen = highlighterRef.current;
    if (pen && api && app.activeTool.type !== 'freedraw') {
      restorePen(api, pen);
      setHighlighter(null);
    }
    setStickyArmed(app.activeTool.type === 'custom' && app.activeTool.customType === STICKY_TOOL);
    if (!api) return;
    // «Ссылка на объект» (R176) — окно выбора объекта закрывается, откуда бы его ни открыли.
    if (app.openDialog?.name === 'elementLinkSelector')
      api.updateScene({ appState: { openDialog: null }, captureUpdate: CaptureUpdateAction.NEVER });
    if (canDraw) fixLinks(elements, app);
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
  const highlighterLabel = t(($) => $.board.actions.highlighter);
  const stickyLabel = t(($) => $.board.actions.sticky);
  // Толщина линии — как у значков Excalidraw рядом (1 px), а не общая для значков Cord.
  const highlighterIcon = <Highlighter strokeWidth={1.5} data-own-stroke />;
  const stickyIcon = <StickyNote strokeWidth={1.5} data-own-stroke />;
  const mode = board.drawers === 'host' ? t(($) => $.board.modes.host) : t(($) => $.board.modes.all);
  const canClear = may('board.clear');
  const canSettings = may('board.settings');
  const status = statusText(t, state);
  const others = [...peers].filter((id) => id !== me).length;

  return (
    <section
      ref={section}
      className="board"
      aria-label={t(($) => $.board.name)}
      data-view-only={viewOnly || undefined}
      data-state={state}
    >
      <header className="board-bar">
        <div className="board-bar__title">
          <span className="board-bar__mark" aria-hidden="true">
            <Presentation size={20} />
          </span>
          <div className="board-bar__heading">
            <h2>{t(($) => $.board.name)}</h2>
            <span className="board-bar__mode">
              {viewOnly ? <Users size={12} aria-hidden="true" /> : <PenLine size={12} aria-hidden="true" />}
              {mode}
              {others > 0 && <span className="board-bar__peers"> · {others + 1}</span>}
            </span>
          </div>
        </div>
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
              <MenuGroup>
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
              </MenuGroup>
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
                  <MenuRadioGroup
                    value={board.drawers}
                    onValueChange={(value) => void run('board.settings', String(value))}
                  >
                    <MenuLabel>{t(($) => $.board.actions.drawers)}</MenuLabel>
                    <MenuRadioItem className="ui-menu__item" value="all" closeOnClick>
                      <span className="ui-menu__icon" aria-hidden="true">
                        <Users />
                      </span>
                      <span className="ui-menu__label">{t(($) => $.board.actions.drawersAll)}</span>
                    </MenuRadioItem>
                    <MenuRadioItem className="ui-menu__item" value="host" closeOnClick>
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
        ref={setCanvasEl}
        className="board-canvas"
        data-drop={drop || undefined}
        data-tool={highlighter ? 'highlighter' : stickyArmed ? 'sticky' : undefined}
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
          // Доска светлая при любой теме Cord (владелец, R166): тёмная тема Excalidraw переворачивает холст.
          theme="light"
          langCode={excalidrawLanguage(i18n.language)}
          viewModeEnabled={!canDraw}
          isCollaborating
          autoFocus={false}
          handleKeyboardGlobally={false}
          validateEmbeddable={() => false}
          aiEnabled={false}
          UIOptions={UI_OPTIONS}
          onChange={onChange}
          onLinkOpen={openLink}
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
        {/* Курсоры соседей — только стрелкой (R168): над холстом, под интерфейсом редактора. */}
        <div ref={cursorRoot} className="board-cursors" aria-hidden="true" />
        {api && <Minimap api={api} />}
        {api && canDraw && (
          <>
            <ToolSlot root={canvasEl} anchor={barAnchor('freedraw')} kind="bar">
              <ToolToggle
                name="highlighter"
                label={highlighterLabel}
                title={t(($) => $.board.tools.highlighter)}
                icon={highlighterIcon}
                checked={!!highlighter}
                onToggle={toggleHighlighter}
              />
            </ToolSlot>
            <ToolSlot root={canvasEl} anchor={barAnchor('text')} kind="bar">
              <ToolToggle
                name="sticky"
                label={stickyLabel}
                title={t(($) => $.board.tools.sticky)}
                icon={stickyIcon}
                checked={stickyArmed}
                onToggle={toggleSticky}
              />
            </ToolSlot>
            <ToolSlot root={canvasEl} anchor={menuAnchor('laser')} kind="menu">
              <MenuTool
                name="highlighter"
                label={highlighterLabel}
                icon={highlighterIcon}
                checked={!!highlighter}
                onPick={toggleHighlighter}
              />
              <MenuTool
                name="sticky"
                label={stickyLabel}
                icon={stickyIcon}
                checked={stickyArmed}
                onPick={() => toggleSticky(false)}
              />
            </ToolSlot>
          </>
        )}
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
        size="md"
        className="board-dialog"
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
        <p className="board-dialog__note">
          {canClear ? t(($) => $.board.import.replaceHint) : t(($) => $.board.import.noReplace)}
        </p>
      </Dialog>
      <Dialog
        open={confirm === 'close'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t(($) => $.board.close.title)}
        size="md"
        className="board-dialog"
        description={t(($) => $.board.close.description)}
        footer={
          <>
            <Button
              variant="secondary"
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
        <p className="board-dialog__note">
          <Clock3 size={16} aria-hidden="true" />
          {t(($) => $.board.chat.retention)}
        </p>
      </Dialog>
      <Dialog
        open={confirm === 'clear'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t(($) => $.board.clear.title)}
        size="sm"
        className="board-dialog"
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

/** Фон холста — «слегка белый, не супер белый» (R166): фон страницы Cord в светлой теме (`--palette-mist-50`). */
const BOARD_BACKGROUND = '#f6f7fa';

/** Как Cord рисует по умолчанию: «аккуратно» (без дрожи), обычным шрифтом, тёмной линией. */
const INITIAL = {
  appState: {
    currentItemRoughness: 0,
    currentItemFontFamily: FONT_FAMILY.Nunito,
    currentItemStrokeColor: '#1e1e1e',
    currentItemStrokeWidth: 2,
    viewBackgroundColor: BOARD_BACKGROUND,
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

/** Отпечаток сцены: номера и версии видимых элементов. У сошедшихся сцен он один и тот же. */
function sceneMark(elements: readonly BoardElement[]): string {
  let hash = 2166136261;
  for (const key of elements.map((el) => `${el.id}:${el.version}:${el.versionNonce}`).sort())
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

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
