import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

/**
 * Конец ленты, который сам просит продолжения.
 *
 * Кнопка настоящая, а не запасная: наблюдатель нажимает её за человека, когда лента доехала
 * до низа, но клавиатура, программа чтения с экрана и браузер без `IntersectionObserver`
 * получают то же самое обычным нажатием. Запас в шесть сотен пикселей — чтобы следующая
 * порция успела приехать до того, как в ленте кончатся карточки.
 */
export function More({ shown, busy, onMore }: { shown: boolean; busy: boolean; onMore: () => void }) {
  const [node, setNode] = useState<HTMLButtonElement | null>(null);
  const latest = useRef(onMore);
  latest.current = onMore;
  useEffect(() => {
    if (!node || busy || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, busy]);
  if (!shown) return null;
  return (
    <button ref={setNode} className="cinema-more" disabled={busy} onClick={onMore}>
      {busy ? <LoaderCircle size={17} /> : null}
      {busy ? 'Загружаем…' : 'Показать ещё'}
    </button>
  );
}
