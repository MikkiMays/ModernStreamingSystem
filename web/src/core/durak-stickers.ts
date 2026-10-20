import type { Translate } from '../i18n';

/**
 * Реакции дурака: протокольный `id`, картинка и `canonicalId` — та же картинка под другим номером
 * (номера держит протокол, рисунков меньше). Подпись — в каталоге по `canonicalId`
 * (`durak.stickers`): у одного рисунка одно имя, под каким бы номером он ни пришёл.
 */
export const DURAK_STICKERS = [
  {
    id: 'durak-online-01',
    asset: '/games/durak-online-01.webp',
    canonicalId: 'durak-online-01',
  },
  {
    id: 'durak-online-02',
    asset: '/games/durak-online-02.webp',
    canonicalId: 'durak-online-02',
  },
  {
    id: 'durak-online-03',
    asset: '/games/durak-online-03.webp',
    canonicalId: 'durak-online-03',
  },
  {
    id: 'durak-online-04',
    asset: '/games/durak-online-04.webp',
    canonicalId: 'durak-online-04',
  },
  {
    id: 'durak-online-05',
    asset: '/games/durak-online-05.webp',
    canonicalId: 'durak-online-05',
  },
  {
    id: 'durak-online-06',
    asset: '/games/durak-online-06.webp',
    canonicalId: 'durak-online-06',
  },
  {
    id: 'durak-online-07',
    asset: '/games/durak-online-07.webp',
    canonicalId: 'durak-online-07',
  },
  {
    id: 'durak-online-08',
    asset: '/games/durak-online-08.webp',
    canonicalId: 'durak-online-08',
  },
  {
    id: 'durak-online-09',
    asset: '/games/durak-online-09.webp',
    canonicalId: 'durak-online-09',
  },
  {
    id: 'durak-online-10',
    asset: '/games/durak-online-10.webp',
    canonicalId: 'durak-online-10',
  },
  {
    id: 'durak-online-11',
    asset: '/games/durak-online-11.webp',
    canonicalId: 'durak-online-11',
  },
  {
    id: 'durak-online-12',
    asset: '/games/durak-online-12.webp',
    canonicalId: 'durak-online-12',
  },
  {
    id: 'durak-online-13',
    asset: '/games/durak-online-13.webp',
    canonicalId: 'durak-online-13',
  },
  {
    id: 'durak-online-14',
    asset: '/games/durak-online-14.webp',
    canonicalId: 'durak-online-14',
  },
  {
    id: 'durak-online-15',
    asset: '/games/durak-online-15.webp',
    canonicalId: 'durak-online-15',
  },
  {
    id: 'durak-online-16',
    asset: '/games/durak-online-16.webp',
    canonicalId: 'durak-online-16',
  },
  {
    id: 'durak-online-17',
    asset: '/games/durak-online-17.webp',
    canonicalId: 'durak-online-17',
  },
  {
    id: 'durak-online-18',
    asset: '/games/durak-online-18.webp',
    canonicalId: 'durak-online-18',
  },
  {
    id: 'durak-online-19',
    asset: '/games/durak-online-19.webp',
    canonicalId: 'durak-online-19',
  },
  {
    id: 'durak-online-20',
    asset: '/games/durak-online-20.webp',
    canonicalId: 'durak-online-20',
  },
  {
    id: 'durak-online-21',
    asset: '/games/durak-online-21.webp',
    canonicalId: 'durak-online-21',
  },
  {
    id: 'durak-online-22',
    asset: '/games/durak-online-22.webp',
    canonicalId: 'durak-online-22',
  },
  {
    id: 'durak-online-23',
    asset: '/games/durak-online-23.webp',
    canonicalId: 'durak-online-23',
  },
  {
    id: 'durak-online-24',
    asset: '/games/durak-online-24.webp',
    canonicalId: 'durak-online-24',
  },
  {
    id: 'durak-online-25',
    asset: '/games/durak-online-25.webp',
    canonicalId: 'durak-online-25',
  },
  {
    id: 'durak-online-26',
    asset: '/games/durak-online-26.webp',
    canonicalId: 'durak-online-26',
  },
  {
    id: 'durak-online-27',
    asset: '/games/durak-online-19.webp',
    canonicalId: 'durak-online-19',
  },
  {
    id: 'durak-online-28',
    asset: '/games/durak-online-06.webp',
    canonicalId: 'durak-online-06',
  },
  {
    id: 'durak-online-29',
    asset: '/games/durak-online-01.webp',
    canonicalId: 'durak-online-01',
  },
  {
    id: 'durak-online-30',
    asset: '/games/durak-online-04.webp',
    canonicalId: 'durak-online-04',
  },
  {
    id: 'durak-online-31',
    asset: '/games/durak-online-16.webp',
    canonicalId: 'durak-online-16',
  },
  {
    id: 'durak-online-32',
    asset: '/games/durak-online-22.webp',
    canonicalId: 'durak-online-22',
  },
  {
    id: 'durak-online-33',
    asset: '/games/durak-online-07.webp',
    canonicalId: 'durak-online-07',
  },
  {
    id: 'durak-online-34',
    asset: '/games/durak-online-18.webp',
    canonicalId: 'durak-online-18',
  },
  {
    id: 'durak-online-35',
    asset: '/games/durak-online-15.webp',
    canonicalId: 'durak-online-15',
  },
  {
    id: 'durak-online-36',
    asset: '/games/durak-online-10.webp',
    canonicalId: 'durak-online-10',
  },
  {
    id: 'durak-online-37',
    asset: '/games/durak-online-25.webp',
    canonicalId: 'durak-online-25',
  },
  {
    id: 'durak-online-38',
    asset: '/games/durak-online-23.webp',
    canonicalId: 'durak-online-23',
  },
  {
    id: 'durak-online-39',
    asset: '/games/durak-online-26.webp',
    canonicalId: 'durak-online-26',
  },
  {
    id: 'durak-online-40',
    asset: '/games/durak-online-20.webp',
    canonicalId: 'durak-online-20',
  },
  {
    id: 'durak-online-41',
    asset: '/games/durak-online-17.webp',
    canonicalId: 'durak-online-17',
  },
  {
    id: 'durak-online-42',
    asset: '/games/durak-online-12.webp',
    canonicalId: 'durak-online-12',
  },
  {
    id: 'durak-online-43',
    asset: '/games/durak-online-14.webp',
    canonicalId: 'durak-online-14',
  },
  {
    id: 'durak-online-44',
    asset: '/games/durak-online-11.webp',
    canonicalId: 'durak-online-11',
  },
  {
    id: 'durak-online-45',
    asset: '/games/durak-online-03.webp',
    canonicalId: 'durak-online-03',
  },
  {
    id: 'durak-online-46',
    asset: '/games/durak-online-24.webp',
    canonicalId: 'durak-online-24',
  },
  {
    id: 'durak-online-47',
    asset: '/games/durak-online-21.webp',
    canonicalId: 'durak-online-21',
  },
  {
    id: 'durak-online-48',
    asset: '/games/durak-online-05.webp',
    canonicalId: 'durak-online-05',
  },
  {
    id: 'durak-online-49',
    asset: '/games/durak-online-08.webp',
    canonicalId: 'durak-online-08',
  },
  {
    id: 'durak-online-50',
    asset: '/games/durak-online-02.webp',
    canonicalId: 'durak-online-02',
  },
  {
    id: 'durak-online-51',
    asset: '/games/durak-online-09.webp',
    canonicalId: 'durak-online-09',
  },
  {
    id: 'durak-online-52',
    asset: '/games/durak-online-52.webp',
    canonicalId: 'durak-online-52',
  },
  {
    id: 'durak-online-53',
    asset: '/games/durak-online-53.webp',
    canonicalId: 'durak-online-53',
  },
  {
    id: 'durak-online-54',
    asset: '/games/durak-online-54.webp',
    canonicalId: 'durak-online-54',
  },
] as const;

export type DurakSticker = (typeof DURAK_STICKERS)[number];

/** Подпись реакции: для экранных читалок, всплывающей подсказки и на случай, если картинка не загрузилась. */
export function stickerLabel(t: Translate, sticker: DurakSticker): string {
  return t(($) => $.durak.stickers[sticker.canonicalId]);
}
