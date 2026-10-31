// Холст и шрифты jsdom — раньше Excalidraw (`test/canvas-stub.ts`).
import '../../test/canvas-stub';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../api/types';
import type { Meeting } from '../../core/meeting';
import { Store } from '../../core/store';
import { i18next } from '../../i18n';
import { ToastProvider } from '../kit';
import BoardStage from './BoardStage';
import { external, scrub } from './hardening';
import { excalidrawLanguage } from './lang';

/**
 * Доска на сцене (R159): кто не рисует — смотрит без инструментов и с подписью; кто рисует — с
 * инструментами Excalidraw и заготовками Cord; ни в шапке, ни в меню, ни в окне помощи редактора нет ни
 * одной ссылки наружу; язык — язык Cord.
 */

/** Сокет без сети: доска в тесте не подключается никуда. */
class Silent {
  static OPEN = 1;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

beforeAll(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = Silent;
});

afterEach(() => {
  cleanup();
});

function meeting(can: string[], drawers: 'all' | 'host' = 'all'): Meeting {
  const snapshot = {
    id: 'room',
    participants: [
      { id: 'me', name: 'Анна', owner: false, status: 'CONNECTED' },
      { id: 'host', name: 'Борис', owner: true, status: 'CONNECTED' },
    ],
    integrationsAllowed: true,
    board: { openedBy: 'host', openedAt: 1, drawers },
    you: { can },
  } as unknown as Snapshot;
  return {
    snapshot: new Store(snapshot),
    admission: { roomId: '00000000-0000-0000-0000-000000000001', participantId: 'me', credential: 'me.x' },
    api: { putBoardFile: async () => {}, boardFile: async () => new Blob() },
    serverNow: () => Date.now(),
    boardLatency: new Store(null),
    boardImport: new Store(null),
    uploader: { send: async () => true },
    command: async () => ({}),
  } as unknown as Meeting;
}

function show(target: Meeting) {
  return render(
    <ToastProvider>
      <div style={{ width: 1200, height: 800 }}>
        <BoardStage meeting={target} />
      </div>
    </ToastProvider>,
  );
}

/** Ссылки за пределы Cord во всём документе (окна Excalidraw — в портале у `body`). */
function externalLinks(): string[] {
  return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .map((link) => link.getAttribute('href') ?? '')
    .filter((href) => external(href));
}

describe('доска на сцене', () => {
  it('кто не рисует — смотрит: подпись, без инструментов и без заготовок', async () => {
    show(meeting(['board.close'], 'host'));
    expect(await screen.findByText('Смотрите: рисует ведущий')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.excalidraw')).toBeTruthy());
    expect(document.querySelector('[data-testid="toolbar-rectangle"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Маркер' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Стикер' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Сохранить в чат' })).toBeInTheDocument();
  });

  it('кто рисует — инструменты Excalidraw по-русски и «Маркер» со «Стикером»', async () => {
    show(meeting(['board.draw', 'board.clear', 'board.settings', 'board.close']));
    await waitFor(() => expect(document.querySelector('[data-testid="toolbar-rectangle"]')).toBeTruthy());
    expect(document.querySelector('[data-testid="toolbar-rectangle"]')?.getAttribute('aria-label')).toBe(
      'Прямоугольник',
    );
    expect(screen.getByRole('button', { name: 'Маркер' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Стикер' })).toBeInTheDocument();
    expect(screen.queryByText('Смотрите: рисует ведущий')).toBeNull();
  });

  it('нигде в доске нет ссылок наружу: ни в шапке, ни в меню, ни в окне помощи', async () => {
    show(meeting(['board.draw', 'board.clear', 'board.settings', 'board.close']));
    await waitFor(() => expect(document.querySelector('.excalidraw')).toBeTruthy());
    expect(externalLinks()).toEqual([]);
    expect(document.querySelector('a[href*="github.com"]')).toBeNull();
    // Главное меню Excalidraw — только пункты Cord, без GitHub, Discord и X.
    const trigger = document.querySelector<HTMLElement>('[data-testid="main-menu-trigger"]');
    expect(trigger).toBeTruthy();
    await act(async () => {
      fireEvent.click(trigger!);
    });
    expect(
      await screen.findByText('Сохранить в чат', { selector: '.dropdown-menu-item__text' }),
    ).toBeTruthy();
    expect(externalLinks()).toEqual([]);
    // Окно помощи (горячие клавиши): у Excalidraw в шапке — документация, блог и GitHub.
    const help = [...document.querySelectorAll<HTMLElement>('.dropdown-menu-item')].find((item) =>
      /Помощь|Help/.test(item.textContent ?? ''),
    );
    expect(help).toBeTruthy();
    await act(async () => {
      fireEvent.click(help!);
    });
    await waitFor(() => expect(document.querySelector('.HelpDialog')).toBeTruthy());
    await waitFor(() => expect(externalLinks()).toEqual([]));
    expect(document.querySelector('a[href*="github.com"]')).toBeNull();
  });

  it('«Ещё»: скачать, открыть файл, кто рисует и очистить — меню открывается и выбирает', async () => {
    show(meeting(['board.draw', 'board.clear', 'board.settings', 'board.close']));
    await waitFor(() => expect(document.querySelector('.excalidraw')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }));
    expect(await screen.findByRole('menuitem', { name: 'Картинкой PNG' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Файлом доски' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Открыть файл' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Все участники' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'Только ведущий' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Очистить доску' })).toBeInTheDocument();
    expect(externalLinks()).toEqual([]);
  });

  it('язык редактора — язык Cord', () => {
    expect(excalidrawLanguage('ru')).toBe('ru-RU');
    expect(excalidrawLanguage('zh-Hans')).toBe('zh-CN');
    expect(excalidrawLanguage('pt-BR')).toBe('pt-BR');
    expect(excalidrawLanguage('de')).toBe('de-DE');
    expect(excalidrawLanguage('xx')).toBe('en');
    expect(i18next.language).toBe('ru');
  });

  it('сторож убирает внешние ссылки интерфейса, а ссылки участников на элементах оставляет', () => {
    document.body.innerHTML = `
      <div class="excalidraw">
        <a id="gh" href="https://github.com/excalidraw/excalidraw">GitHub</a>
        <a id="own" href="/download">Cord</a>
        <div class="excalidraw-hyperlinkContainer"><a id="user" href="https://example.org">ссылка</a></div>
      </div>
      <a id="outside" href="https://example.org">вне доски</a>`;
    expect(scrub(document.body, 'https://cord.example')).toBe(1);
    expect(document.getElementById('gh')).toBeNull();
    expect(document.getElementById('own')).toBeTruthy();
    expect(document.getElementById('user')).toBeTruthy();
    expect(document.getElementById('outside')).toBeTruthy();
    expect(external('javascript:alert(1)', 'https://cord.example')).toBe(true);
    expect(external('#top', 'https://cord.example')).toBe(false);
  });
});
