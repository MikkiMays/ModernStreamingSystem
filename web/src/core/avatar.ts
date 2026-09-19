/**
 * Everything the room sees has to fit the server's budget for a picture.
 *
 * Это число знает и ядро (`RoomService.AVATAR_URI`), и оно там **одно**: байтовая граница
 * считается из него, а не назначается отдельно. Пока их было две, они разошлись — и картинка,
 * влезавшая сюда, отвергалась комнатой.
 */
export const avatarMaxLength = 3500;
/**
 * Сколько пикселей в картинке профиля.
 *
 * ЛЕСТНИЦА, А НЕ ЧИСЛО. Раньше здесь стояло 64 — и это была не экономия, а недоразумение:
 * бюджет комнаты (3500 символов) картинка такого размера не тратила и наполовину, зато на
 * плитке участника она растягивается до ста двадцати шести пикселей, а на экране с двойной
 * плотностью — до двухсот пятидесяти. Отсюда и «ужасное качество»: снимок увеличивали вчетверо.
 *
 * Теперь берётся самый крупный размер, который **влезает в тот же бюджет**: снимок комнаты от
 * этого не растёт ни на байт, а пикселей в картинке становится в девять раз больше.
 */
export const avatarSizes = [192, 160, 128, 96, 64] as const;
export const avatarSize = avatarSizes[0];

/**
 * Какой кусок снимка попадёт в кружок.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ. Раньше картинка резалась по центру и только по центру. На портрете
 * это отрезает голову, на групповом снимке оставляет чьё-то плечо, а исправить это можно было
 * только в стороннем редакторе — то есть выйти из Cord, чтобы поставить себе аватар.
 *
 * Кадр описан не пикселями, а долями: `zoom` — во сколько раз он ближе вписанного квадрата,
 * `x` и `y` — где его середина в долях ширины и высоты. Так одно и то же описание подходит
 * и снимку с телефона, и картинке в сто пикселей, и ничего не надо пересчитывать при показе.
 */
export interface AvatarCrop {
  /** 1 — вписанный квадрат целиком; больше — ближе. */
  zoom: number;
  x: number;
  y: number;
}
export const wholePicture: AvatarCrop = { zoom: 1, x: 0.5, y: 0.5 };

/** Сторона кадра в пикселях исходника и его левый верхний угол — с поправкой на края. */
export function cropRect(width: number, height: number, crop: AvatarCrop) {
  const side = Math.min(width, height) / Math.max(1, crop.zoom);
  const clamp = (value: number, limit: number) => Math.min(limit - side / 2, Math.max(side / 2, value));
  return {
    side,
    left: clamp(crop.x * width, width) - side / 2,
    top: clamp(crop.y * height, height) - side / 2,
  };
}

export async function openPicture(file: File): Promise<ImageBitmap> {
  if (!file.type.startsWith('image/')) throw new Error('Нужен файл с картинкой');
  if (file.size > 20 * 1024 * 1024) throw new Error('Картинка слишком большая');
  return createImageBitmap(file).catch(() => {
    throw new Error('Не удалось прочитать картинку');
  });
}

/**
 * Переводит выбранный кадр в квадратный data URI, самый подробный из влезающих в бюджет.
 *
 * ДВЕ ЛЕСТНИЦЫ, А НЕ ОДНА. Сначала снижается качество, потом размер: у плоского логотипа и
 * подробной фотографии бюджет расходуется по-разному, и одна настройка на всех означала бы
 * либо мыло на логотипе, либо отказ на фотографии. Порядок именно такой: 192 пикселя при
 * скромном качестве выглядят лучше, чем 96 при щедром, — резкость границ человек замечает
 * раньше, чем шум внутри них.
 *
 * WebP пробуется первым: он вдвое экономнее JPEG на тех же пикселях, а бюджет здесь и есть
 * ограничение.
 */
export function encodeAvatar(bitmap: ImageBitmap, crop: AvatarCrop = wholePicture): string {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Не удалось обработать картинку');
  const { side, left, top } = cropRect(bitmap.width, bitmap.height, crop);
  // A browser without WebP quietly returns a PNG instead, which would blow the budget on
  // every single step. Asking once is cheaper than discovering it twenty-five times.
  canvas.width = canvas.height = 8;
  const types = canvas.toDataURL('image/webp').startsWith('data:image/webp')
    ? ['image/webp', 'image/jpeg']
    : ['image/jpeg'];
  for (const type of types)
    for (const size of avatarSizes) {
      canvas.width = canvas.height = size;
      context.clearRect(0, 0, size, size);
      context.drawImage(bitmap, left, top, side, side, 0, 0, size, size);
      for (const quality of [0.82, 0.7, 0.58, 0.45, 0.32]) {
        const encoded = canvas.toDataURL(type, quality);
        if (encoded.startsWith(`data:${type}`) && encoded.length <= avatarMaxLength) return encoded;
      }
    }
  throw new Error('Не удалось уменьшить картинку до нужного размера');
}

/** Файл целиком, кадром по центру: путь для тех, кому выбирать кадр негде. */
export async function readAvatar(file: File): Promise<string> {
  const bitmap = await openPicture(file);
  try {
    return encodeAvatar(bitmap, wholePicture);
  } finally {
    bitmap.close();
  }
}
