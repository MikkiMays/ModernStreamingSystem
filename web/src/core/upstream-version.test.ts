import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// Модуль запоминает ответ на загрузку страницы, поэтому каждому тесту нужна своя копия.
const load = (build: string) => {
  vi.doMock('./version', () => ({ appVersion: '0.7.0', appBuild: build, appLabel: '0.7.0' }));
  return import('./upstream-version');
};

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('./version');
});

it('молчит, когда сервер на последнем коммите', async () => {
  vi.mocked(fetch).mockResolvedValue(answer({ status: 'identical', ahead_by: 0 }));
  const { upstreamState } = await load('a47e421');
  await expect(upstreamState()).resolves.toBeNull();
});

it('называет, на сколько коммитов отстал', async () => {
  vi.mocked(fetch).mockResolvedValue(answer({ status: 'ahead', ahead_by: 7 }));
  const { upstreamState } = await load('a47e421');
  await expect(upstreamState()).resolves.toEqual({ behind: 7 });
  // Спрашивается один раз за загрузку страницы.
  await upstreamState();
  expect(fetch).toHaveBeenCalledTimes(1);
});

/**
 * Форк, своя ветка или сборка не из git. Гадать не о чем: плашка про отставание от чужого
 * проекта была бы не подсказкой, а неправдой.
 */
it('молчит про чужой или неизвестный коммит', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }));
  const { upstreamState } = await load('deadbee');
  await expect(upstreamState()).resolves.toBeNull();
});

it('не ходит в сеть, когда сборка не знает своего коммита', async () => {
  const { upstreamState } = await load('');
  await expect(upstreamState()).resolves.toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('переживает недоступную сеть', async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
  const { upstreamState } = await load('a47e421');
  await expect(upstreamState()).resolves.toBeNull();
});

/**
 * Первая же правка документации после выкатки делает прод «отставшим на коммит». Плашка,
 * зовущая пересобрать сервер ради опечатки в тексте, обесценивает и тот случай, когда звать
 * действительно надо.
 */
it('молчит, когда впереди только документация', async () => {
  vi.mocked(fetch).mockResolvedValue(
    answer({
      status: 'ahead',
      ahead_by: 3,
      files: [
        { filename: 'docs/frontend.md' },
        { filename: 'README.md' },
        { filename: '.github/workflows/ci.yml' },
      ],
    }),
  );
  const { upstreamState } = await load('a47e421');
  await expect(upstreamState()).resolves.toBeNull();
});

it('говорит, как только среди правок есть хоть одна рабочая', async () => {
  vi.mocked(fetch).mockResolvedValue(
    answer({
      status: 'ahead',
      ahead_by: 3,
      files: [{ filename: 'docs/frontend.md' }, { filename: 'web/src/ui/Stage.tsx' }],
    }),
  );
  const { upstreamState } = await load('a47e421');
  await expect(upstreamState()).resolves.toEqual({ behind: 3 });
});

it('не считает правкой сервера то, что выполняется только в проверке', async () => {
  const { affectsServer } = await load('a47e421');
  expect(
    affectsServer([
      { filename: 'web/e2e/screens.spec.ts' },
      { filename: 'web/src/ui/focus.test.ts' },
      { filename: 'server/src/test/java/dev/mikki/stream/RoomServiceTest.java' },
    ]),
  ).toBe(false);
  expect(affectsServer([{ filename: 'server/src/main/java/dev/mikki/stream/room/RoomService.java' }])).toBe(
    true,
  );
});

/** Обрезанный на трёхстах файлах или отсутствующий список — повод сказать, а не промолчать. */
it('при неизвестном составе правок показывает плашку', async () => {
  const { affectsServer } = await load('a47e421');
  expect(affectsServer(undefined)).toBe(true);
  expect(affectsServer([])).toBe(true);
  expect(affectsServer([{ filename: 'update.sh' }])).toBe(true);
  expect(affectsServer([{ filename: 'LICENSE' }])).toBe(false);
});

it('склоняет коммиты по-русски', async () => {
  const { commitsLabel } = await load('a47e421');
  expect(commitsLabel(1)).toBe('1 коммит');
  expect(commitsLabel(3)).toBe('3 коммита');
  expect(commitsLabel(7)).toBe('7 коммитов');
  expect(commitsLabel(11)).toBe('11 коммитов');
  expect(commitsLabel(21)).toBe('21 коммит');
  expect(commitsLabel(22)).toBe('22 коммита');
  expect(commitsLabel(112)).toBe('112 коммитов');
});
