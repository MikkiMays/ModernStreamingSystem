import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Download } from '../ui/Download';
import { Settings } from '../ui/Settings';
import { applyLanguage, type Language } from './index';

/**
 * Дымовой прогон экранов на других языках (E14-B): экран рисуется целиком по каталогу языка,
 * без русских строк и без ключей вместо текста.
 */
vi.mock('../core/download', async (original) => ({
  ...(await original<typeof import('../core/download')>()),
  windowsRelease: async () => ({
    version: '9.8.7',
    publishedAt: '',
    installer: {
      name: 'Cord-Setup-9.8.7-x64.exe',
      kind: 'installer' as const,
      size: 300 * 1024 * 1024,
      url: '/downloads/windows/v9.8.7/Cord-Setup-9.8.7-x64.exe',
    },
    portable: null,
  }),
}));

const CYRILLIC = /[А-Яа-яЁё]/;
/** Ключ i18next вместо текста — «settings.title», «download.installer». */
const RAW_KEY = /\b[a-z]+\.[a-z][A-Za-z-]*(\.[A-Za-z-]+)*\b/;

interface Texts {
  settings: string;
  voice: string;
  nav: string;
  download: string;
  installer: string;
}

const screens: Record<string, Texts> = {
  en: {
    settings: 'Settings',
    voice: 'Audio',
    nav: 'Settings sections',
    download: 'Cord for Windows',
    installer: 'Download installer',
  },
  'zh-Hans': {
    settings: '设置',
    voice: '音频',
    nav: '设置分区',
    download: 'Windows 版 Cord',
    installer: '下载安装程序',
  },
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);
afterAll(async () => {
  await act(() => applyLanguage('ru'));
});

describe.each(Object.keys(screens))('экраны на языке %s', (language) => {
  const text = screens[language]!;

  beforeEach(async () => {
    // Файл каталога — отдельный модуль: на занятой машине первая загрузка идёт секунды.
    await act(() => applyLanguage(language as Language));
  }, 60_000);

  it('настройки: окно, разделы и «Звук» — на этом языке, без русского', () => {
    render(<Settings open section="audio" onOpenChange={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: text.settings });
    const nav = within(dialog).getByRole('navigation', { name: text.nav });
    expect(within(nav).getByRole('button', { name: text.voice })).toHaveAttribute('aria-current', 'page');
    expect(document.documentElement.lang).toBe(language);
    // Имена устройств из браузера и «Cord» — не текст каталога; русского быть не должно вовсе.
    expect(dialog.textContent).not.toMatch(CYRILLIC);
    expect(dialog.textContent).not.toMatch(RAW_KEY);
  });

  it('страница скачивания: заголовок, установщик и предупреждение SmartScreen — на этом языке', async () => {
    const view = render(<Download />);
    expect(await screen.findByRole('link', { name: new RegExp(text.installer) })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(text.download);
    expect(view.container.textContent).not.toMatch(CYRILLIC);
  });
});
