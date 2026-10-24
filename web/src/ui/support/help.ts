import type { FaqId } from '../../core/support';
import type { CallReport } from '../../media/call-quality';
import { Store } from '../../core/store';

/**
 * Окно «Поддержка» — одно на всё приложение (S5, R49): его рисует `HelpHost` на корне, а кнопки
 * поддержки только просят его открыться.
 *
 * ПОЧЕМУ НЕ ОКНО В КАЖДОЙ КНОПКЕ. Так было: своё окно лежало в дереве того, кто его открыл. В
 * «Диагностике» помощь открывалась под ней (слой старого окна выше) и вложенным окном — нажатие на
 * видную часть помощи было «нажатием снаружи», и она закрывалась; оставить обращение было нельзя.
 * Закрыть диагностику тоже не выходило: вместе с ней пропадала и кнопка с окном помощи. Окно на
 * корне от открывшего не зависит — открывший сначала закрывается сам: замена, а не стопка.
 */
export interface HelpRequest {
  /** С какого вопроса начать (нет доступа к камере — `camera`). */
  faq?: FaqId;
  /**
   * Во встрече — «Открыть диагностику» вместо проверки устройств: помощь закрывается, диагностика
   * открывается.
   */
  onDiagnostics?: () => void;
  /** Сразу «Сообщить о проблеме» (R79): вкладка «Написать», выбор того, что не так. */
  report?: boolean;
}

/** Открытое окно помощи и с чем его открыли; `null` — закрыто. */
export const helpRequest = new Store<HelpRequest | null>(null);

export function openHelp(request: HelpRequest = {}) {
  helpRequest.set({ ...request });
}

export function closeHelp() {
  helpRequest.set(null);
}

/**
 * Итог идущего звонка для «Сообщить о проблеме» (R79) — откуда его взять. Окно поддержки живёт на
 * корне и встречи не знает, поэтому встреча сама ставит сюда свой `callReport` на время, пока она
 * на экране, и снимает, уходя. Вне встречи — `null`: прикладывать нечего.
 */
export const callReportSource = new Store<(() => CallReport | null) | null>(null);

/** Встреча на экране: её итог звонка доступен поддержке; возвращает «встреча ушла». */
export function provideCallReport(source: () => CallReport | null) {
  callReportSource.set(source);
  return () => {
    if (callReportSource.get() === source) callReportSource.set(null);
  };
}
