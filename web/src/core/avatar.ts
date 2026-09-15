/** Everything the room sees has to fit the server's budget for a picture. */
export const avatarSize = 64;
export const avatarMaxLength = 3500;

/**
 * Turns a chosen file into a small square data URI.
 *
 * The picture is cropped to a square around its centre and drawn at a fixed size, so a photo of
 * any shape or resolution becomes the same small payload. WebP is tried first and quality is
 * stepped down until the result fits, because a single quality setting cannot suit both a flat
 * logo and a detailed photograph.
 */
export async function readAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Нужен файл с картинкой');
  if (file.size > 20 * 1024 * 1024) throw new Error('Картинка слишком большая');

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('Не удалось прочитать картинку');
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = avatarSize;
    canvas.height = avatarSize;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Не удалось обработать картинку');
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      avatarSize,
      avatarSize,
    );
    for (const type of ['image/webp', 'image/jpeg']) {
      for (const quality of [0.8, 0.65, 0.5, 0.35]) {
        const encoded = canvas.toDataURL(type, quality);
        // A browser without WebP quietly returns a PNG instead, which would blow the budget.
        if (!encoded.startsWith(`data:${type}`)) break;
        if (encoded.length <= avatarMaxLength) return encoded;
      }
    }
    throw new Error('Не удалось уменьшить картинку до нужного размера');
  } finally {
    bitmap.close();
  }
}
