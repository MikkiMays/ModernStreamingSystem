import { CaptureUpdateAction, reconcileElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type {
  BinaryFileData,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from '@excalidraw/excalidraw/types';
import { isInk } from '../../core/board/export';
import type { LocalFiles } from '../../core/board/files';
import type { BoardElement } from '../../core/board/protocol';
import type { BoardCanvas, Cursor } from '../../core/board/sync';

/** Кто это у доски: имя и цвет курсора. */
export interface BoardPerson {
  name: string;
  color: string;
}

/**
 * Холст синхронизации поверх Excalidraw (R159).
 *
 * Чужие правки ложатся через `reconcileElements` — то же слияние, что у совместной работы Excalidraw: оно
 * не перебивает правимое, держит порядок слоёв по дробному индексу и чинит индексы. И всегда с
 * `CaptureUpdateAction.NEVER`: в историю отмены попадает только своё — отмена у каждого своя.
 */
export class ExcalidrawCanvas implements BoardCanvas, LocalFiles {
  constructor(
    private readonly api: ExcalidrawImperativeAPI,
    private readonly people: () => ReadonlyMap<string, BoardPerson>,
  ) {}

  elements(): readonly BoardElement[] {
    return this.api.getSceneElementsIncludingDeleted() as unknown as readonly BoardElement[];
  }

  editing(): ReadonlySet<string> {
    const state = this.api.getAppState();
    const ids = new Set<string>();
    for (const el of [state.editingTextElement, state.resizingElement, state.newElement])
      if (el) ids.add(el.id);
    return ids;
  }

  drawing(): BoardElement | null {
    const el = this.api.getAppState().newElement;
    return el && el.type === 'freedraw' ? (el as unknown as BoardElement) : null;
  }

  merge(elements: BoardElement[]) {
    const remote = new Set(elements.map((el) => el.id));
    // Готовый штрих соседа заменяет его временный целиком: временный слиянию не участник.
    const local = this.api
      .getSceneElementsIncludingDeleted()
      .filter((el) => !(remote.has(el.id) && isInk(el as unknown as BoardElement)));
    const merged = reconcileElements(
      local as readonly OrderedExcalidrawElement[],
      elements as unknown as readonly RemoteExcalidrawElement[],
      this.api.getAppState(),
    );
    this.api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
  }

  replace(elements: BoardElement[]) {
    this.api.updateScene({
      elements: elements as unknown as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.api.history.clear();
  }

  ink(put: BoardElement[], remove: string[]) {
    const gone = new Set(remove);
    const fresh = new Map(put.map((el) => [el.id, el]));
    const next: ExcalidrawElement[] = [];
    for (const el of this.api.getSceneElementsIncludingDeleted()) {
      const board = el as unknown as BoardElement;
      if (gone.has(el.id) && isInk(board)) continue;
      const replacement = fresh.get(el.id);
      if (replacement) {
        if (isInk(board)) next.push(replacement as unknown as ExcalidrawElement);
        else next.push(el);
        fresh.delete(el.id);
      } else next.push(el);
    }
    for (const el of fresh.values()) next.push(el as unknown as ExcalidrawElement);
    this.api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }

  cursors(cursors: ReadonlyMap<string, Cursor>) {
    const people = this.people();
    const collaborators = new Map<SocketId, Collaborator>();
    for (const [id, cursor] of cursors) {
      const person = people.get(id);
      if (!person) continue;
      collaborators.set(id as SocketId, {
        id,
        socketId: id as SocketId,
        username: person.name,
        color: { background: person.color, stroke: person.color },
        pointer: { x: cursor.x, y: cursor.y, tool: cursor.tool },
        button: cursor.button,
        selectedElementIds: Object.fromEntries(cursor.selection.map((selected) => [selected, true])),
      });
    }
    this.api.updateScene({ collaborators });
  }

  // --- картинки ----------------------------------------------------------------------------

  get(fileId: string) {
    const file = this.api.getFiles()[fileId];
    return file ? { dataURL: file.dataURL, mimeType: file.mimeType } : undefined;
  }

  add(files: { id: string; dataURL: string; mimeType: string; created: number }[]) {
    this.api.addFiles(files as unknown as BinaryFileData[]);
  }
}
