import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Accordion } from '@base-ui/react/accordion';
import { Activity, ChevronDown } from 'lucide-react';
import { readPreferences } from '../../core/preferences';
import { FAQ, type FaqId, type SupportTopic } from '../../core/support';
import { DeviceCheck } from '../DeviceCheck';
import { Button, Segmented, Tab, TabList, TabPanel, Tabs } from '../kit';
import { ReportForm } from './ReportForm';
import { SupportForm } from './SupportForm';
import './support.css';

/** С какой темы начинать форму, если помощь открыли у конкретной беды. */
const TOPIC_OF: Record<FaqId, SupportTopic> = {
  camera: 'camera',
  microphone: 'camera',
  silent: 'sound',
  screen: 'screen',
  smartscreen: 'windows',
  network: 'network',
};

type HelpTab = 'faq' | 'check' | 'write';
type WriteMode = 'message' | 'report';

/**
 * «Поддержка» целиком (E13, T36, R38): три вкладки — «Частые вопросы», «Проверить», «Написать». Одно и
 * то же в окне на корне (`HelpHost`), в разделе «Поддержка» настроек (R51) и на странице `/support`.
 *
 * Прежде это была одна длинная колонка: шесть раскрывашек, проверка, форма и Telegram автора — в окне
 * 720 px до формы нужно было долистать. Теперь каждая часть — своя вкладка, и окно не длиннее самой
 * длинной из них. Вопросы — аккордеон (открыт один), «Написать» — обращение или «Сообщить о
 * проблеме» (R79) с выбором того, что не так, и отчётом о звонке.
 *
 * `faq` — вопрос, у которого человек застрял (нет доступа к камере — `camera`): он раскрыт, и форма
 * начинается с его темы. `onDiagnostics` — во встрече вместо проверки устройств её «Диагностика», где
 * видно и связь. `report` — открыть сразу «Сообщить о проблеме».
 */
export function HelpCenter({
  faq,
  onDiagnostics,
  report = false,
}: {
  faq?: FaqId;
  onDiagnostics?: () => void;
  report?: boolean;
}) {
  const { t } = useTranslation();
  const preferences = useMemo(() => readPreferences(), []);
  const [tab, setTab] = useState<HelpTab>(report ? 'write' : 'faq');
  // «Написать» рисуется, когда к ней пришли, и дальше живёт скрытой: окно открывается быстро, а
  // недописанное не теряется при переходе к вопросам и обратно.
  const [writing, setWriting] = useState(report);
  const [mode, setMode] = useState<WriteMode>(report ? 'report' : 'message');
  const [open, setOpen] = useState<FaqId[]>(faq ? [faq] : []);
  const order = faq ? [faq, ...FAQ.filter((item) => item !== faq)] : [...FAQ];
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as HelpTab);
        if (value === 'write') setWriting(true);
      }}
      className="help-center"
    >
      <TabList className="help-tabs" aria-label={t(($) => $.support.tabs.label)}>
        <Tab value="faq">{t(($) => $.support.tabs.faq)}</Tab>
        <Tab value="check">{t(($) => $.support.tabs.check)}</Tab>
        <Tab value="write">{t(($) => $.support.tabs.write)}</Tab>
      </TabList>
      <TabPanel value="faq" className="help-panel">
        <Accordion.Root
          className="help-faq"
          value={open}
          onValueChange={(value) => setOpen(value as FaqId[])}
        >
          {order.map((item) => (
            <Accordion.Item key={item} value={item} className="help-faq__item">
              <Accordion.Header className="help-faq__header">
                <Accordion.Trigger className="help-faq__trigger">
                  <span>{t(($) => $.support.faq.items[item].q)}</span>
                  <ChevronDown aria-hidden="true" className="help-faq__chevron" />
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Panel className="help-faq__panel">
                <ul className="help-faq__steps">
                  {t(($) => $.support.faq.items[item].a)
                    .split('\n')
                    .map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                </ul>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      </TabPanel>
      <TabPanel value="check" className="help-panel help-check">
        {onDiagnostics ? (
          <>
            <p className="help-lead">{t(($) => $.support.check.diagnosticsText)}</p>
            <Button size="sm" icon={<Activity />} onClick={onDiagnostics}>
              {t(($) => $.support.check.diagnostics)}
            </Button>
          </>
        ) : (
          <DeviceCheck preferences={preferences} />
        )}
      </TabPanel>
      <TabPanel value="write" className="help-panel help-write" keepMounted={writing}>
        <Segmented<WriteMode>
          full
          size="sm"
          aria-label={t(($) => $.support.write.label)}
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'message', label: t(($) => $.support.write.message) },
            { value: 'report', label: t(($) => $.support.write.report) },
          ]}
        />
        {mode === 'report' ? <ReportForm /> : <SupportForm topic={faq ? TOPIC_OF[faq] : undefined} />}
      </TabPanel>
    </Tabs>
  );
}
