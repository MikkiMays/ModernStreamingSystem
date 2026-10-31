import { Component, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../kit';

/**
 * Сбой доски не роняет встречу (R159). У приложения нет общей границы ошибок: исключение внутри
 * редактора (чужой код на сотни килобайт) или неудачная загрузка его чанка размонтировали бы весь экран
 * встречи — с камерами, чатом и пультом. Здесь доска падает одна: «Доска не открылась» и «Попробовать
 * снова», а звонок идёт дальше.
 */
export class BoardBoundary extends Component<{ children: ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[cord] board', error);
  }

  render() {
    if (this.state.failed)
      return (
        <BoardFailed
          onRetry={() => this.setState(({ attempt }) => ({ failed: false, attempt: attempt + 1 }))}
        />
      );
    return (
      <div key={this.state.attempt} className="board-boundary">
        {this.props.children}
      </div>
    );
  }
}

function BoardFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="board-failed" role="alert">
      <p>{t(($) => $.board.failed)}</p>
      <Button variant="secondary" icon={<RotateCcw />} onClick={onRetry}>
        {t(($) => $.board.retry)}
      </Button>
    </div>
  );
}
