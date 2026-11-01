import type { ReactNode } from 'react';
import { useId } from 'react';

/**
 * Шаг «добавить во встречу» у интеграции, которая открывается сразу у всех (музыка, доска — R164).
 *
 * Карточка витрины ведёт сюда, а не делает дело сама: значок, имя, одна-две строки о том, что
 * случится, и одна кнопка. «Нет» — стрелка «Интеграции» над шагом, как у любой группы витрины.
 * Нажал «Доску рисования» — и она тут же развернулась у всех во встрече, — ровно на это владелец и
 * жаловался: у остальных интеграций спрашивают, у доски — нет.
 *
 * Кому добавлять нельзя (организатор оставил интеграции себе), кнопки нет — вместо неё строка почему.
 */
export function IntegrationIntro({
  icon,
  title,
  children,
  action,
  locked,
  error,
}: {
  icon: ReactNode;
  title: string;
  /** Что будет: строка, а под ней — тихие подробности (очередь, что осталась с прошлого раза). */
  children: ReactNode;
  /** Главная кнопка; без неё — {@link locked}. */
  action?: ReactNode;
  locked: string;
  error?: string | null;
}) {
  const id = useId();
  return (
    <section className="integration-intro" aria-labelledby={id}>
      <span className="integration-intro__icon" aria-hidden="true">
        {icon}
      </span>
      <h3 id={id}>{title}</h3>
      {children}
      {action ?? <p className="integration-intro__note">{locked}</p>}
      {error && (
        <p className="services-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
