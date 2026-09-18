/** Everything the room sees has to fit the server's budget for a picture. */
export const avatarSize = 64;
export const avatarMaxLength = 3500;

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
 * Переводит выбранный кадр в маленький квадратный data URI.
 *
 * WebP пробуется первым, и качество снижается по ступеням, пока результат не уложится в
 * бюджет: одна настройка качества не годится одновременно плоскому логотипу и подробной
 * фотографии.
 */
export function encodeAvatar(bitmap: ImageBitmap, crop: AvatarCrop = wholePicture): string {
  const canvas = document.createElement('canvas');
  canvas.width = avatarSize;
  canvas.height = avatarSize;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Не удалось обработать картинку');
  const { side, left, top } = cropRect(bitmap.width, bitmap.height, crop);
  context.drawImage(bitmap, left, top, side, side, 0, 0, avatarSize, avatarSize);
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const quality of [0.8, 0.65, 0.5, 0.35]) {
      const encoded = canvas.toDataURL(type, quality);
      // A browser without WebP quietly returns a PNG instead, which would blow the budget.
      if (!encoded.startsWith(`data:${type}`)) break;
      if (encoded.length <= avatarMaxLength) return encoded;
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
