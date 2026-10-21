import { useEffect, useState } from 'react';
import { AppWindow, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  listCaptureSources,
  systemAudioAvailable,
  type CaptureAudio,
  type CaptureSource,
  type CaptureSources,
} from '../core/desktop-capture';
import { Button, Dialog, Switch, Tab, TabList, TabPanel, Tabs } from './kit';
import './capture-picker.css';

/** Миниатюры окон меняются, пока окно выбора открыто: раз в четыре секунды — как живые, но без нагрузки. */
const REFRESH_MS = 4000;

export interface CaptureChoice {
  id: string;
  audio: CaptureAudio;
}

/**
 * Окно выбора источника показа в клиенте на Electron (T10, E01-B2, ADR 0001 §4.1) — вместо окна
 * оболочки, по дизайну E16, как в Discord: вкладки «Экраны» и «Окна», плитки с миниатюрой и значком
 * приложения, «Со звуком системы» (только Windows) и «Показать». Двойной щелчок по плитке — сразу
 * показать. Свои окна Cord оболочка в список не кладёт.
 */
export function CapturePicker({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: CaptureChoice) => void;
}) {
  const { t } = useTranslation();
  const [found, setFound] = useState<CaptureSources | null>(null);
  const [kind, setKind] = useState<CaptureSource['kind']>('screen');
  const [chosen, setChosen] = useState<string | null>(null);
  const [audio, setAudio] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      const next = await listCaptureSources();
      busy = false;
      if (alive) setFound(next);
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      setFound(null);
      setChosen(null);
    };
  }, [open]);

  const sources = found?.sources ?? [];
  // Закрытое за это время окно из выбора пропадает само, а не остаётся невидимой «выбранной» плиткой.
  const selected = sources.some((source) => source.id === chosen) ? chosen : null;
  const withSound = systemAudioAvailable() && found?.systemAudio === true;
  const choose = (id: string | null) => {
    if (!id) return;
    onChoose({ id, audio: withSound && audio ? 'system' : 'none' });
  };

  const grid = (which: CaptureSource['kind']) => {
    const shown = sources.filter((source) => source.kind === which);
    if (!found)
      return (
        <p className="capture-picker__empty" role="status">
          {t(($) => $.capture.loading)}
        </p>
      );
    if (!shown.length)
      return (
        <p className="capture-picker__empty" role="status">
          {which === 'screen' ? t(($) => $.capture.noScreens) : t(($) => $.capture.noWindows)}
        </p>
      );
    return (
      <div className="capture-picker__grid" role="group" aria-label={t(($) => $.capture.sources)}>
        {shown.map((source) => (
          <button
            key={source.id}
            type="button"
            className="capture-tile"
            aria-pressed={selected === source.id}
            onClick={() => setChosen(source.id)}
            onDoubleClick={() => choose(source.id)}
          >
            <span className="capture-tile__thumb">
              {source.thumbnail ? (
                <img src={source.thumbnail} alt="" draggable={false} />
              ) : which === 'screen' ? (
                <Monitor size={28} aria-hidden="true" />
              ) : (
                <AppWindow size={28} aria-hidden="true" />
              )}
            </span>
            <span className="capture-tile__label">
              {source.icon && <img src={source.icon} alt="" width={16} height={16} draggable={false} />}
              <span>{source.name || t(($) => $.capture.untitled)}</span>
            </span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(($) => $.capture.title)}
      size="lg"
      className="capture-picker"
      footer={
        <>
          {withSound && (
            <Switch
              className="capture-picker__audio"
              checked={audio}
              onCheckedChange={setAudio}
              label={t(($) => $.capture.systemAudio)}
              description={t(($) => $.capture.systemAudioHint)}
            />
          )}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t(($) => $.capture.cancel)}
          </Button>
          <Button variant="primary" disabled={!selected} onClick={() => choose(selected)}>
            {t(($) => $.capture.share)}
          </Button>
        </>
      }
    >
      <Tabs value={kind} onValueChange={(value) => setKind(value as CaptureSource['kind'])}>
        <TabList aria-label={t(($) => $.capture.kinds)}>
          <Tab value="screen" icon={<Monitor size={16} />}>
            {t(($) => $.capture.screens)}
          </Tab>
          <Tab value="window" icon={<AppWindow size={16} />}>
            {t(($) => $.capture.windows)}
          </Tab>
        </TabList>
        <TabPanel value="screen">{grid('screen')}</TabPanel>
        <TabPanel value="window">{grid('window')}</TabPanel>
      </Tabs>
    </Dialog>
  );
}
