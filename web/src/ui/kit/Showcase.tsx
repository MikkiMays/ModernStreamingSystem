import {
  Camera,
  Copy,
  Link2,
  Mic,
  MicOff,
  Monitor,
  MoreHorizontal,
  Pencil,
  Pin,
  Settings,
  Share2,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { FullscreenLoader } from '../loader/FullscreenLoader';
import { IntegrationsSample } from '../IntegrationsSample';
import {
  AppIcon,
  Badge,
  Button,
  Card,
  CordMark,
  CordWordmark,
  Dialog,
  Drawer,
  Field,
  IconButton,
  Input,
  Logo,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSwitchItem,
  MenuTrigger,
  Popover,
  ResizeHandle,
  Segmented,
  Select,
  Separator,
  Slider,
  Soon,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  ToastProvider,
  usePanelWidth,
  useToast,
} from './index';
import './showcase.css';

type Theme = 'system' | 'light' | 'dark';

/**
 * Витрина набора: маршрут `/kit`, без сервера и сессии. Каждый примитив — во всех
 * состояниях и в обеих темах рядом (`data-theme` на колонке), меню, диалог и тосты — в теме
 * страницы (переключатель вверху). Это же страница для axe и для кадров в `screens/E16/`.
 */
export function Showcase() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('cord:theme') as Theme) || 'system');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <ToastProvider>
      <div className="kit">
        <header className="kit__bar">
          <Logo height={26} />
          <h1 className="kit__title">Набор примитивов</h1>
          <Tabs value={theme} onValueChange={(value) => setTheme(value as Theme)} className="kit__theme">
            <TabList aria-label="Тема страницы">
              <Tab value="system">Система</Tab>
              <Tab value="light">Светлая</Tab>
              <Tab value="dark">Тёмная</Tab>
            </TabList>
          </Tabs>
        </header>
        <div className="kit__panes">
          <div className="kit__pane" data-theme="light">
            <Sections theme="light" />
          </div>
          <div className="kit__pane" data-theme="dark">
            <Sections theme="dark" />
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="kit__section">
      <h2 className="kit__h2">{title}</h2>
      {children}
    </section>
  );
}

function Sections({ theme }: { theme: 'light' | 'dark' }) {
  const [slider, setSlider] = useState(62);
  const [quality, setQuality] = useState<720 | 1080 | 1440>(720);
  const [fps, setFps] = useState<30 | 60>(30);
  const [on, setOn] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [autojoin, setAutojoin] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [loader, setLoader] = useState<'cord' | 'cards' | null>(null);
  const toast = useToast();
  const panel = usePanelWidth(`showcase-${theme}`, { min: 200, max: 420, default: 280 });
  return (
    <div className="kit__sections">
      <Section title="Марка">
        <div className="kit__row">
          <Logo />
          <CordMark size={30} />
          <CordWordmark height={30} />
          <AppIcon size={48} />
          <span className="kit__mono">
            <Logo />
          </span>
        </div>
      </Section>

      <Section title="Типографика">
        <p
          className="kit__type"
          style={{ fontSize: 'var(--text-2xl)', letterSpacing: 'var(--tracking-display)', fontWeight: 600 }}
        >
          Планёрка в 11:00
        </p>
        <p className="kit__type" style={{ fontSize: 'var(--text-xl)', fontWeight: 600 }}>
          Голос и видео
        </p>
        <p className="kit__type" style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>
          Пригласить участников
        </p>
        <p className="kit__type" style={{ fontSize: 'var(--text-md)' }}>
          Cord — видеовстречи, демонстрация экрана и разговор без лишних шагов.
        </p>
        <p className="kit__type" style={{ fontSize: 'var(--text-base)' }}>
          Основной текст интерфейса: строки списков, кнопки, подписи полей.
        </p>
        <p className="kit__type kit__muted" style={{ fontSize: 'var(--text-sm)' }}>
          Второстепенный текст: пояснения под настройками, состояние участника.
        </p>
        <p className="kit__type kit__muted" style={{ fontSize: 'var(--text-xs)' }}>
          Подписи и метаданные: время сообщения, качество 1080p · 60.
        </p>
      </Section>

      <Section title="Цвета">
        <div className="kit__swatches">
          {['--bg', '--surface-1', '--surface-2', '--surface-3', '--accent-soft', '--danger-soft'].map(
            (name) => (
              <span key={name} className="kit__swatch" style={{ background: `var(${name})` }}>
                {name}
              </span>
            ),
          )}
          {['--accent-fill', '--danger-fill', '--live'].map((name) => (
            <span key={name} className="kit__swatch kit__swatch--on" style={{ background: `var(${name})` }}>
              {name}
            </span>
          ))}
        </div>
        <p className="kit__type">
          <span style={{ color: 'var(--text)' }}>text</span> ·{' '}
          <span style={{ color: 'var(--text-secondary)' }}>text-secondary</span> ·{' '}
          <span style={{ color: 'var(--muted)' }}>muted</span> ·{' '}
          <span style={{ color: 'var(--accent)' }}>accent</span> ·{' '}
          <span style={{ color: 'var(--danger)' }}>danger</span> ·{' '}
          <span style={{ color: 'var(--success)' }}>success</span> ·{' '}
          <span style={{ color: 'var(--warning)' }}>warning</span>
        </p>
      </Section>

      <Section title="Кнопки">
        <div className="kit__row">
          <Button variant="primary">Пригласить</Button>
          <Button>Изменить</Button>
          <Button variant="quiet">Права участников</Button>
          <Button variant="danger">Выйти из встречи</Button>
        </div>
        <div className="kit__row">
          <Button variant="primary" icon={<Link2 />}>
            Скопировать ссылку
          </Button>
          <Button size="sm">Маленькая</Button>
          <Button size="lg" variant="primary">
            Войти во встречу
          </Button>
          <Button disabled>Недоступна</Button>
          <Button variant="primary" loading>
            Подключаем
          </Button>
        </div>
      </Section>

      <Section title="Кнопки-значки">
        <div className="kit__row">
          <IconButton label="Настройки">
            <Settings size={20} />
          </IconButton>
          <IconButton label="Участники" variant="solid">
            <Users size={20} />
          </IconButton>
          <IconButton label="Удалить" variant="danger">
            <Trash2 size={20} />
          </IconButton>
          <IconButton label="Микрофон включён" pressed>
            <Mic size={20} />
          </IconButton>
          <IconButton label="Ещё" size="sm">
            <MoreHorizontal size={16} />
          </IconButton>
          <IconButton label="Поделиться" size="lg">
            <Share2 size={24} />
          </IconButton>
          <IconButton label="Недоступно" disabled>
            <Camera size={20} />
          </IconButton>
        </div>
        <div className="kit__stage media-stage">
          <IconButton label="Микрофон включён" tone="stage" pressed size="lg">
            <Mic size={24} />
          </IconButton>
          <IconButton label="Камера выключена" tone="stage" pressed={false} size="lg">
            <Camera size={24} />
          </IconButton>
          <IconButton label="Показать экран" tone="stage" size="lg">
            <Monitor size={24} />
          </IconButton>
          <span className="kit__tile">
            <Badge variant="live">В эфире</Badge>
            <span className="kit__caption">
              <MicOff size={16} /> Виталий
            </span>
          </span>
        </div>
      </Section>

      <Section title="Поля">
        <div className="kit__grid">
          <Field label="Имя" description="Так вас видят во встрече">
            <Input defaultValue="Полина" />
          </Field>
          <Field label="Код встречи" error="Такой встречи нет">
            <Input defaultValue="AX7-K2M" aria-invalid />
          </Field>
          <Field label="Микрофон">
            <Select defaultValue="yeti">
              <option value="yeti">Yeti Nano</option>
              <option value="built">Встроенный микрофон</option>
            </Select>
          </Field>
          <Field label="Описание" description="Необязательно">
            <Textarea placeholder="О чём встреча" />
          </Field>
          <Field label="Недоступно">
            <Input disabled value="Только в клиенте" readOnly />
          </Field>
        </div>
      </Section>

      <Section title="Ползунок и переключатель">
        <div className="kit__grid">
          <Field label="Громкость" description={`${slider} %`} inline>
            <Slider value={slider} onChange={(e) => setSlider(Number(e.target.value))} label="Громкость" />
          </Field>
          <Field label="Выключено" inline>
            <Slider value={0} label="Ноль" readOnly />
          </Field>
          <Field label="Полная" inline>
            <Slider value={100} label="Сто" readOnly />
          </Field>
          <Field label="Недоступен" inline>
            <Slider value={40} label="Недоступен" disabled />
          </Field>
        </div>
        <div className="kit__grid">
          <Switch
            checked={on}
            onCheckedChange={setOn}
            label="Подавление шума"
            description="Клавиатура и фон тише, голос — нет"
          />
          <Switch checked={!on} onCheckedChange={(v) => setOn(!v)} label="Эхоподавление" />
          <Switch checked disabled onCheckedChange={() => {}} label="Недоступно" />
          <Switch checked={on} onCheckedChange={setOn} ariaLabel="Без подписи" />
        </div>
      </Section>

      <Section title="Сегмент">
        <p className="kit__muted">
          Выбор значения, а не вкладка: радиогруппа, стрелки переключают, недоступное объяснено в title.
        </p>
        <div className="kit__row">
          <Segmented
            aria-label="Камера: качество"
            value={quality}
            onValueChange={setQuality}
            options={[
              { value: 720, label: '720p' },
              { value: 1080, label: '1080p' },
              {
                value: 1440,
                label: '1440p',
                disabled: true,
                title: 'Этот сервер допускает до 1080p · 60 fps',
              },
            ]}
          />
          <Segmented
            aria-label="Камера: частота кадров"
            value={fps}
            onValueChange={setFps}
            options={[
              { value: 30, label: '30 fps' },
              { value: 60, label: '60 fps' },
            ]}
          />
          <Segmented
            aria-label="Зум камеры"
            size="sm"
            defaultValue={1}
            options={[
              { value: 0.5, label: '0.5×' },
              { value: 1, label: '1×' },
              { value: 2, label: '2×' },
            ]}
          />
        </div>
        <Segmented
          aria-label="Режим показа"
          full
          defaultValue="detail"
          options={[
            { value: 'detail', label: 'Чёткость', icon: <Monitor /> },
            { value: 'motion', label: 'Плавность', icon: <Camera /> },
          ]}
        />
      </Section>

      <Section title="Вкладки">
        <Tabs defaultValue="people">
          <TabList aria-label="Разделы встречи">
            <Tab value="people" icon={<Users />}>
              Люди
            </Tab>
            <Tab value="chat">Чат</Tab>
            <Tab value="bots">Боты</Tab>
            <Tab value="off" disabled>
              Нет
            </Tab>
          </TabList>
          <TabPanel value="people">Четыре участника</TabPanel>
          <TabPanel value="chat">Сообщений нет</TabPanel>
          <TabPanel value="bots">Боты и интеграции</TabPanel>
        </Tabs>
        <Tabs defaultValue="sound" variant="line">
          <TabList aria-label="Настройки звука">
            <Tab value="sound">Звук</Tab>
            <Tab value="video">Видео</Tab>
            <Tab value="screen">Демонстрация</Tab>
          </TabList>
        </Tabs>
      </Section>

      <Section title="Меню, диалог, тост">
        <div className="kit__row">
          <Menu>
            <MenuTrigger render={<Button icon={<MoreHorizontal />}>Меню встречи</Button>} />
            <MenuContent>
              <MenuItem icon={<Pencil />} shortcut="F2">
                Переименовать
              </MenuItem>
              <MenuItem icon={<Pin />} shortcut="Ctrl+P">
                Закрепить
              </MenuItem>
              <MenuSubmenu icon={<Copy />} label="Скопировать">
                <MenuItem shortcut="Ctrl+L">Ссылку</MenuItem>
                <MenuItem>Код</MenuItem>
              </MenuSubmenu>
              <MenuSwitchItem icon={<Zap />} checked={autojoin} onCheckedChange={setAutojoin}>
                Автоподключение
              </MenuSwitchItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} destructive>
                Удалить из избранного
              </MenuItem>
            </MenuContent>
          </Menu>
          <Button onClick={() => setDialog(true)}>Открыть диалог</Button>
          <Popover
            trigger={<Button>Всплывающая карточка</Button>}
            title="Сейчас играет"
            width={320}
            mobile="popover"
          >
            <p className="kit__muted">Ночной город — Кино. Управление, не уходя со сцены.</p>
          </Popover>
          <Button onClick={() => setSheet(true)}>Лист снизу</Button>
          <Button onClick={() => toast.add({ title: 'Ссылка скопирована', type: 'success' })}>Тост</Button>
          <Button
            variant="quiet"
            onClick={() =>
              toast.add({
                title: 'Не удалось подключиться',
                description: 'Сервер не ответил за 10 секунд.',
                type: 'danger',
                timeout: 0,
                actionProps: { children: 'Повторить' },
              })
            }
          >
            Тост с действием
          </Button>
        </div>
        <Drawer open={sheet} onOpenChange={setSheet} title="Музыка">
          <p className="kit__muted">Плеер и очередь на телефоне. Ручку можно стянуть вниз.</p>
        </Drawer>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="Выйти из встречи?"
          description="Остальные продолжат разговор без вас. Вернуться можно по той же ссылке."
          footer={
            <>
              <Button onClick={() => setDialog(false)}>Остаться</Button>
              <Button variant="danger" onClick={() => setDialog(false)}>
                Выйти
              </Button>
            </>
          }
        />
      </Section>

      <Section title="Бейджи и карточки">
        <div className="kit__row">
          <Badge>12 файлов</Badge>
          <Badge variant="accent">Вы</Badge>
          <Badge variant="success">Идёт</Badge>
          <Badge variant="danger">Нет связи</Badge>
          <Badge variant="live">В эфире</Badge>
          <Badge variant="new">Новое</Badge>
          <Soon />
          <Badge variant="count">3</Badge>
        </div>
        <div className="kit__grid">
          <Card>
            <b>Планёрка</b>
            <p className="kit__muted">AX7-K2M · вчера</p>
          </Card>
          <Card interactive>
            <b>Покер по пятницам</b>
            <p className="kit__muted">Идёт · 3 человека</p>
          </Card>
          <Card level={2}>
            <b>Поднятая</b>
            <p className="kit__muted">Уровень 2: всплывающие блоки</p>
          </Card>
        </div>
        <Separator />
      </Section>

      <Section title="Ручка-разделитель">
        <div
          className="kit__resizable"
          style={{ gridTemplateColumns: `${panel.width}px 12px minmax(0, 1fr)` }}
        >
          <div className="kit__side">
            <b>Избранное</b>
            <p className="kit__muted">{panel.width} px · двойной щелчок — по умолчанию</p>
          </div>
          <ResizeHandle
            value={panel.width}
            min={panel.min}
            max={panel.max}
            onChange={panel.setWidth}
            onReset={panel.reset}
            label="Ширина левой панели"
          />
          <div className="kit__main">Содержимое</div>
        </div>
      </Section>

      <Section title="Интеграции">
        <p className="kit__muted">Витрина и музыка панели встречи на образцах: панель 320 и 400 px.</p>
        <IntegrationsSample theme={theme} />
      </Section>

      <Section title="Загрузка">
        <div className="kit__row">
          <Button onClick={() => setLoader('cord')}>Показать старт</Button>
          <Button onClick={() => setLoader('cards')}>Показать карты</Button>
        </div>
        <div className="kit__grid">
          <FullscreenLoader ready={false} label="Открываем Cord" inline />
          <FullscreenLoader ready={false} label="Раздаём карты" scene="cards" tone="dark" inline />
        </div>
        {loader && (
          <FullscreenLoader
            ready={false}
            label={loader === 'cord' ? 'Открываем Cord' : 'Раздаём карты'}
            scene={loader}
            tone={loader === 'cards' ? 'dark' : 'theme'}
            slowAfterMs={1500}
            onRetry={() => setLoader(null)}
          />
        )}
      </Section>
    </div>
  );
}
