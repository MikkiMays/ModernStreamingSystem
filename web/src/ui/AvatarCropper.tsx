import { useEffect, useRef, useState } from 'react';
import { Modal, Slider } from './primitives';
import { cropRect, encodeAvatar, type AvatarCrop } from '../core/avatar';

/** Сторона окошка кадрирования в пикселях страницы. Реальный аватар меньше в четыре раза. */
const STAGE = 256;

/**
 * Выбор кадра для картинки профиля.
 *
 * ЗАЧЕМ. В кружок помещается квадрат, а снимки бывают любой формы — и вырезанный по центру
 * квадрат портрета это чаще всего подбородок и плечо. Здесь показывается ровно то, что
 * увидит комната: круглая рамка, картинку под ней можно двигать и приближать.
 *
 * Картинка не масштабируется в canvas по ходу перетаскивания: пересчитывается только кадр —
 * три числа, — а в 64×64 всё сводится один раз, когда человек согласился.
 */
export function AvatarCropper({
  bitmap,
  onCancel,
  onSave,
}: {
  bitmap: ImageBitmap;
  onCancel: () => void;
  onSave: (avatar: string) => void;
}) {
  const [crop, setCrop] = useState<AvatarCrop>({ zoom: 1, x: 0.5, y: 0.5 });
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<{ pointer: number; x: number; y: number } | null>(null);
  // Кадр — это часть исходника; сколько пикселей страницы приходится на один его пиксель,
  // зависит от приближения, и от этого же зависит, насколько «быстро» тянется картинка.
  const { side } = cropRect(bitmap.width, bitmap.height, crop);
  const scale = STAGE / side;

  useEffect(() => {
    const surface = canvas.current;
    const context = surface?.getContext('2d');
    if (!surface || !context) return;
    const { side: source, left, top } = cropRect(bitmap.width, bitmap.height, crop);
    context.clearRect(0, 0, surface.width, surface.height);
    context.drawImage(bitmap, left, top, source, source, 0, 0, surface.width, surface.height);
  }, [bitmap, crop]);

  const move = (dx: number, dy: number) =>
    setCrop((current) => ({
      ...current,
      // Тянут картинку, а кадр едет навстречу: иначе движение кажется зеркальным.
      x: Math.min(1, Math.max(0, current.x - dx / scale / bitmap.width)),
      y: Math.min(1, Math.max(0, current.y - dy / scale / bitmap.height)),
    }));

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Что будет в кружке"
      description="Потяните картинку и приблизьте так, как хотите показать себя комнате."
    >
      <div className="avatar-crop">
        <canvas
          ref={canvas}
          width={STAGE}
          height={STAGE}
          className="avatar-crop-stage"
          aria-label="Кадр картинки профиля"
          onPointerDown={(e) => {
            dragging.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const drag = dragging.current;
            if (!drag || drag.pointer !== e.pointerId) return;
            move(e.clientX - drag.x, e.clientY - drag.y);
            dragging.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY };
          }}
          onPointerUp={() => (dragging.current = null)}
          onPointerCancel={() => (dragging.current = null)}
          // Клавиатура — такой же способ выбрать кадр: шаг в десятую долю кадра.
          tabIndex={0}
          onKeyDown={(e) => {
            const step = STAGE / 10;
            const by: Record<string, [number, number]> = {
              ArrowLeft: [step, 0],
              ArrowRight: [-step, 0],
              ArrowUp: [0, step],
              ArrowDown: [0, -step],
            };
            const shift = by[e.key];
            if (!shift) return;
            e.preventDefault();
            move(shift[0], shift[1]);
          }}
        />
        <span className="avatar-crop-mask" aria-hidden="true" />
      </div>
      <label className="gain-setting avatar-crop-zoom">
        Приближение · {crop.zoom.toFixed(1)}×
        <Slider
          min={100}
          max={400}
          step={1}
          value={Math.round(crop.zoom * 100)}
          aria-label="Приближение картинки"
          onChange={(e) => setCrop((current) => ({ ...current, zoom: Number(e.target.value) / 100 }))}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="check-actions">
        <button
          className="button primary"
          onClick={() => {
            try {
              onSave(encodeAvatar(bitmap, crop));
            } catch (problem) {
              setError((problem as Error).message);
            }
          }}
        >
          Поставить
        </button>
        <button className="button ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}
