import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Download } from './Download';
import { DownloadLink } from './primitives';

/**
 * T58: номер версии показывает только «О программе». Страница скачивания ведёт на последний
 * установщик, но его номер не печатает; ссылка «Скачать Cord» в шапке — тоже без номера.
 * Номер остаётся там, где его читает браузер, а не человек: в адресе и имени файла.
 */
const release = vi.hoisted(() => ({
  version: '9.8.7',
  publishedAt: '',
  installer: {
    name: 'Cord-Setup-9.8.7-x64.exe',
    kind: 'installer' as const,
    size: 300 * 1024 * 1024,
    url: '/downloads/windows/v9.8.7/Cord-Setup-9.8.7-x64.exe',
  },
  portable: null,
}));
vi.mock('../core/download', async (original) => ({
  ...(await original<typeof import('../core/download')>()),
  windowsRelease: async () => release,
}));

afterEach(cleanup);

it('links the newest installer without printing its version', async () => {
  const view = render(<Download />);
  const installer = await screen.findByRole('link', { name: /Скачать установщик/ });
  expect(installer).toHaveAttribute('href', release.installer.url);
  expect(view.container).toHaveTextContent('300 МБ');
  expect(view.container.textContent).not.toContain(release.version);
});

it('names the client in the header link without a version', () => {
  render(<DownloadLink />);
  const link = screen.getByRole('link', { name: 'Скачать Cord' });
  expect(link).toHaveAttribute('href', '/download');
  expect(link).toHaveAttribute('title', 'Cord для Windows');
});
