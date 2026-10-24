import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { listedProviders, PROVIDER_IDS, providerName, PROVIDERS, SWITCHER_TABS } from './providers';
import type { CinemaProvidersResponse } from './types';
import { BRAND_IDS } from '../../ui/brands';

describe('реестр площадок', () => {
  it('идентификаторы не повторяются', () => {
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
  });

  it('у PROVIDERS ровно по одной карточке на id реестра, в том же порядке', () => {
    expect(Object.keys(PROVIDERS)).toEqual([...PROVIDER_IDS]);
  });

  it('у каждой площадки есть своя сцена и заполненная карточка', () => {
    for (const id of PROVIDER_IDS) {
      const spec = PROVIDERS[id];
      expect(spec.id).toBe(id);
      expect(providerName(t, id)).toBeTruthy();
      expect(t(($) => $.cinema.providers[id].hint)).toBeTruthy();
      expect(t(($) => $.cinema.providers[id].search)).toBeTruthy();
      expect(spec.scene).toBeTruthy();
      // У площадки-компонента должен быть render — так отличают настоящую иконку от «забыли».
      expect(typeof spec.icon).toBe('object');
      // Цвет площадки — переменная её бренда из общего реестра (R33), а не свой hex.
      expect(spec.accent).toBe(`var(--brand-${id})`);
      expect(BRAND_IDS).toContain(id);
    }
  });

  it('у Rutube своя сцена и цвет из их CSS', () => {
    expect(PROVIDERS.rutube.scene).toBe('rutube');
    expect(PROVIDERS.rutube.accent).toBe('var(--brand-rutube)');
    expect(t(($) => $.cinema.providers.rutube.search)).toBe('Видео, каналы и ТВ');
  });

  it('у VK Видео своя сцена, цвет из их VKUI и поиск по видео и сообществам', () => {
    expect(PROVIDER_IDS.indexOf('vk')).toBe(3);
    expect(PROVIDERS.vk.scene).toBe('vk');
    expect(PROVIDERS.vk.accent).toBe('var(--brand-vk)');
    expect(t(($) => $.cinema.providers.vk.search)).toBe('Видео и сообщества');
  });

  it('«По ссылке» — последняя плитка, своя сцена и нейтральный серый, а не цвет площадки', () => {
    expect(PROVIDER_IDS.at(-1)).toBe('link');
    expect(PROVIDERS.link).toMatchObject({ scene: 'link', accent: 'var(--brand-link)' });
    expect(providerName(t, 'link')).toBe('По ссылке');
    expect(t(($) => $.cinema.providers.link.search)).toBe('Вставьте ссылку на видео');
  });

  it('вкладки переключателя — площадки сцены switcher, тем же порядком, что в реестре', () => {
    expect(SWITCHER_TABS).toEqual(PROVIDER_IDS.filter((id) => PROVIDERS[id].scene === 'switcher'));
    expect(SWITCHER_TABS).toEqual(['youtube', 'twitch']);
  });
});

/** Ответ `GET …/cinema/providers` с этими площадками — в том порядке, в каком их назвала служба. */
const answer = (...ids: string[]) =>
  ({
    providers: ids.map((id) => ({
      id,
      available: true,
      reason: null,
      account: 'none',
      connected: false,
      features: {
        search: true,
        channels: false,
        playlists: false,
        categories: false,
        series: false,
        live: false,
      },
    })),
  }) as unknown as CinemaProvidersResponse;

describe('какие площадки показывать по ответу службы', () => {
  it('ответа нет — весь реестр, как до этой проверки', () => {
    expect(listedProviders(undefined)).toEqual(PROVIDER_IDS);
  });

  it('выключенной на сервере площадки нет — порядок реестра, а не ответа', () => {
    // `CINEMA_PROVIDERS=link,youtube,rutube,vk` на проде: Twitch и ivi выключены.
    expect(listedProviders(answer('link', 'youtube', 'rutube', 'vk'))).toEqual([
      'youtube',
      'rutube',
      'vk',
      'link',
    ]);
  });

  it('площадку, которой эта сборка не знает, показать нечем', () => {
    expect(listedProviders(answer('youtube', 'jellyfin'))).toEqual(['youtube']);
  });

  it('служба назвала пустой список — не показывается ничего; ответила не тем — весь реестр', () => {
    expect(listedProviders(answer())).toEqual([]);
    expect(listedProviders({} as CinemaProvidersResponse)).toEqual(PROVIDER_IDS);
    expect(listedProviders({ items: [], next: null } as unknown as CinemaProvidersResponse)).toEqual(
      PROVIDER_IDS,
    );
  });
});
