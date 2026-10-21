#!/usr/bin/env node
// Код для `use_figma` (E15-A): флоу на странице «Флоу» — превью экранов со страницы «Как есть»
// (та же картинка по imageHash, без повторной загрузки), стрелки с действием и условием.
//
//   node scripts/figma-flows.mjs --flows first-run,create [--y 0]
//   node scripts/figma-flows.mjs --list
//
// Кадры-источники ищутся в Figma по имени «id / ширина / dark» на странице «Как есть».
// Повторный запуск пересоздаёт раздел флоу с тем же именем.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--'))
      pairs.push([
        value.slice(2),
        all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : 'true',
      ]);
    return pairs;
  }, []),
);

// Узел: [ключ, состояние, колонка, ряд, подпись] — состояние `splash:Стадия` — экземпляр заставки,
// `box:текст` — карточка без экрана (шаг вне браузера). Ребро: [откуда, куда, действие].
const FLOWS = {
  'first-run': {
    title: '1 · Первый вход: загрузка → подключение → главная',
    note: 'Cord открывается на сервере. Открытый сервер проходится сам; закрытый ждёт пароль; молчащий — показывает причину.',
    nodes: [
      ['a', 'loader', 0, 0, 'Загрузка index.html'],
      ['b', 'connect-searching', 1, 0, 'Ищем сервер…'],
      ['c', 'home', 3, 0, 'Главная'],
      ['d', 'connect-password', 2, 1, 'Нужен пароль'],
      ['e', 'connect-wrong-password', 3, 1, 'Пароль не подошёл'],
      ['f', 'connect-failed', 2, 2, 'Сервер не отвечает'],
      ['g', 'connect-manual', 2, -1, 'Автоподключение выключено'],
    ],
    edges: [
      ['a', 'b', 'первый кадр приложения'],
      ['b', 'c', 'сервер открыт → подключается сам'],
      ['b', 'd', 'сервер закрыт паролем'],
      ['d', 'c', 'ввёл пароль, «Подключиться»'],
      ['d', 'e', 'пароль неверный'],
      ['b', 'f', 'нет ответа / ошибка 5xx'],
      ['b', 'g', 'автоподключение выключено'],
      ['g', 'c', '«Подключиться»'],
    ],
  },
  create: {
    title: '2 · Создать встречу: главная → прихожая → встреча',
    note: 'Камера и микрофон в прихожей выключены до нажатия; войти можно и без устройств.',
    nodes: [
      ['a', 'home', 0, 0, 'Главная'],
      ['b', 'prejoin-create', 1, 0, 'Прихожая: новая встреча'],
      ['c', 'meeting-solo', 2, 0, 'Встреча: один участник'],
      ['d', 'meeting-invite', 3, 0, 'Пригласить во встречу'],
      ['e', 'prejoin-settings', 2, 1, 'Перед разговором (устройства)'],
      ['f', 'prejoin-denied', 2, 2, 'Браузер запретил устройства'],
    ],
    edges: [
      ['a', 'b', '«Новая встреча»'],
      ['b', 'c', '«Начать встречу»'],
      ['c', 'd', 'код в шапке или «Пригласить участников»'],
      ['b', 'e', '«Настройки предпросмотра»'],
      ['b', 'f', '«Включить камеру» → отказ'],
    ],
  },
  join: {
    title: '3 · Войти по коду или ссылке',
    note: 'Код 9 цифр или ссылка /join/… ведут в прихожую входа; встреча с подтверждением держит гостя у двери.',
    nodes: [
      ['a', 'home', 0, 0, 'Главная: поле кода'],
      ['b', 'prejoin-join', 1, 0, 'Прихожая: почти на месте'],
      ['c', 'meeting-grid', 3, 0, 'Встреча'],
      ['d', 'meeting-waiting', 2, 1, 'Ожидание допуска'],
      ['e', 'room-not-found', 1, 2, 'Сессия не найдена'],
    ],
    edges: [
      ['a', 'b', 'ввёл код / открыл ссылку'],
      ['b', 'c', '«Войти во встречу»'],
      ['b', 'd', 'встреча с подтверждением'],
      ['d', 'c', 'организатор впустил'],
      ['a', 'e', 'старая ссылка /room/… без входа'],
    ],
  },
  invite: {
    title: '4 · Пригласить: ссылка → второй участник',
    note: 'Приглашение — код, ссылка и QR. Второй человек проходит свою прихожую.',
    nodes: [
      ['a', 'meeting-solo', 0, 0, 'Один во встрече'],
      ['b', 'meeting-invite', 1, 0, 'Пригласить во встречу'],
      ['c', 'prejoin-join@360', 2, 0, 'Второй: прихожая (телефон)'],
      ['d', 'meeting-grid', 3, 0, 'Встреча: сетка'],
    ],
    edges: [
      ['a', 'b', '«Пригласить участников»'],
      ['b', 'c', '«Скопировать приглашение» → отправил'],
      ['c', 'd', '«Войти во встречу»'],
    ],
  },
  screen: {
    title: '5 · Демонстрация экрана',
    note: 'Показ не навязывается: у зрителя на плитке «Смотреть стрим», экран открывается по нажатию.',
    nodes: [
      ['a', 'meeting-grid', 0, 0, 'Встреча'],
      ['b', 'meeting-screen-tile', 1, 0, 'Аня показывает экран'],
      ['c', 'meeting-screen', 2, 0, 'Экран на сцене'],
      ['d', 'meeting-grid', 3, 0, 'Обратно в разговор'],
    ],
    edges: [
      ['a', 'b', 'Аня: «Показать экран» → выбор окна'],
      ['b', 'c', 'зритель: «Смотреть стрим»'],
      ['c', 'd', '«Вернуться в разговор» / «Остановить показ»'],
    ],
  },
  cinema: {
    title: '6 · Кинозал вместе',
    note: 'Каталог личный — у остальных на сцене разговор; «Смотреть вместе» открывает плеер у всех, люди уходят лентой.',
    nodes: [
      ['a', 'meeting-grid', 0, 0, 'Встреча'],
      ['b', 'meeting-integrations', 1, 0, 'Интеграции'],
      ['c', 'cinema-catalog', 2, 0, 'Каталог площадки'],
      ['d', 'cinema-detail', 3, 0, 'Карточка ролика'],
      ['e', 'cinema-player', 4, 0, 'Плеер у всех'],
    ],
    edges: [
      ['a', 'b', '«Интеграции»'],
      ['b', 'c', '«Кинозал» → YouTube'],
      ['c', 'd', 'поиск → «Подробнее»'],
      ['d', 'e', '«Смотреть вместе»'],
    ],
  },
  games: {
    title: '7 · Игровой стол',
    note: 'Игры — из панели интеграций; правила в ядре, браузер получает готовое. Ботов нет: нужно двое и больше.',
    nodes: [
      ['a', 'meeting-integrations', 0, 0, 'Интеграции'],
      ['b', 'games-panel', 1, 0, 'Группа «Игры»'],
      ['c', 'game-poker', 2, 0, 'Покер'],
      ['d', 'game-durak', 2, 1, 'Дурак'],
      ['e', 'game-chess', 2, 2, 'Шахматы'],
      ['f', 'game-gartic', 2, 3, 'Gartic'],
      ['g', 'games-history', 3, 0, 'История игр'],
    ],
    edges: [
      ['a', 'b', '«Игры»'],
      ['b', 'c', '«Открыть стол» → «Сесть» → «Раздать»'],
      ['b', 'd', '«Открыть стол» → «Сесть» → «Раздать»'],
      ['b', 'e', '«Открыть доску» → белые/чёрные → «Начать партию»'],
      ['b', 'f', '«Открыть Gartic» → «Присоединиться» → «Начать игру»'],
      ['c', 'g', 'стол убран → итог в истории'],
    ],
  },
  settings: {
    title: '8 · Настройки',
    note: 'Одно окно на всё приложение: с главной и из встречи. На телефоне — список разделов → раздел → «К разделам».',
    nodes: [
      ['a', 'home', 0, 0, 'Главная'],
      ['b', 'settings-04', 1, 0, 'Голос и видео (по умолчанию)'],
      ['c', 'settings-search', 2, 0, 'Поиск по настройкам'],
      ['d', 'meeting-more', 0, 1, 'Встреча: «ещё»'],
      ['e', 'meeting-settings', 1, 1, 'Настройки поверх встречи'],
      ['f', 'settings-list@360', 0, 2, 'Телефон: список'],
      ['g', 'settings-02@360', 1, 2, 'Телефон: раздел'],
    ],
    edges: [
      ['a', 'b', '«Настройки» (на телефоне — в меню)'],
      ['b', 'c', '«Найти настройку»'],
      ['d', 'e', '«Настройки»'],
      ['f', 'g', 'раздел; назад — «К разделам»'],
    ],
  },
  'one-meeting': {
    title: '9 · Одна встреча на устройство (T52)',
    note: 'Ядро отвечает 409 ALREADY_IN_MEETING; выбор словами. Вкладки одного браузера видят друг друга и без ядра.',
    nodes: [
      ['a', 'prejoin-create', 0, 0, 'Вход во вторую встречу'],
      ['b', 'dialog-409', 1, 0, '«Вы уже во встрече»'],
      ['c', 'meeting-grid', 2, 0, 'Та встреча'],
      ['d', 'meeting-solo', 2, 1, 'Новая встреча'],
      ['e', 'prejoin-create', 2, 2, 'Остался в прихожей'],
      ['f', 'home-active-elsewhere', 0, 3, 'Главная: встреча в соседней вкладке'],
      ['g', 'meeting-grid', 1, 3, 'Встреча переехала в эту вкладку'],
    ],
    edges: [
      ['a', 'b', '«Начать встречу» → 409'],
      ['b', 'c', '«Перейти туда»'],
      ['b', 'd', '«Выйти оттуда и войти сюда»'],
      ['b', 'e', '«Остаться»'],
      ['f', 'g', '«Вернуться» — перенос тем же участником'],
    ],
  },
  update: {
    title: '10 · Обновление клиента при запуске, как в Discord (В-1, T58)',
    note: 'Маленькое окно до приложения: проверка (≤ 5 с) → загрузка → установка → новая версия открывается сама. «Позже» нет. Зеркало молчит — Cord открывается и спросит в фоне (каждые 6 ч; во встрече и в прихожей не прерывает).',
    nodes: [
      ['s', 'box:Запуск Cord.exe', 0, 0, 'Запуск'],
      ['a', 'splash:Проверка', 1, 0, 'Проверяем обновления…'],
      ['b', 'splash:Загрузка', 2, 0, 'Загружаем обновление… N%'],
      ['c', 'splash:Установка', 3, 0, 'Устанавливаем…'],
      ['r', 'box:Cord закрывается, установщик ставит новую версию и открывает её', 4, 0, 'Перезапуск'],
      ['h', 'desktop-home', 2, 1, 'Cord: главная клиента'],
      ['f', 'splash:Сбой', 3, 2, 'Сбой: причина, «Повторить», «Открыть Cord»'],
    ],
    edges: [
      ['s', 'a', 'окно-заставка 300×360'],
      ['a', 'b', 'есть новее'],
      ['b', 'c', 'пакет проверен (адрес, размер, SHA-256)'],
      ['c', 'r', 'помощник установки готов'],
      ['a', 'h', 'новее нет / зеркало молчит 5 с'],
      ['b', 'f', 'загрузка встала (60 с) или сломалась'],
      ['f', 'h', '«Открыть Cord»'],
    ],
  },
  recovery: {
    title: '11 · Обрыв и восстановление',
    note: 'Медиа: сцена остаётся, обратный отсчёт 20 с. Управление: тихая полоса, разговор идёт. Не вернулось — встреча кончается для этого окна.',
    nodes: [
      ['a', 'meeting-grid', 0, 0, 'Встреча'],
      ['b', 'meeting-recovering', 1, 0, 'Возвращаемся в разговор'],
      ['c', 'meeting-grid', 2, 0, 'Связь вернулась'],
      ['d', 'meeting-control-lost', 1, 1, 'Восстанавливаем чат и управление'],
      ['e', 'meeting-ended', 2, 2, 'Встреча завершена'],
    ],
    edges: [
      ['a', 'b', 'пропал медиа-канал'],
      ['b', 'c', 'вернулся за 20 с'],
      ['a', 'd', 'пропал канал событий'],
      ['b', 'e', 'не вернулся за 20 с / «Завершить для всех»'],
    ],
  },
  download: {
    title: '12 · Скачать и поставить клиент',
    note: 'Загрузка — только с сервера Cord. Установщик и первый запуск — вне браузера (E01); после установки — заставка обновления.',
    nodes: [
      ['a', 'home', 0, 0, 'Главная: «Скачать Cord»'],
      ['b', 'download', 1, 0, '/download'],
      ['c', 'box:Установщик Windows (Inno Setup; E01-B — NSIS)', 2, 0, 'Установка'],
      ['d', 'splash:Проверка', 3, 0, 'Первый запуск'],
      ['e', 'desktop-home', 4, 0, 'Главная клиента'],
      ['f', 'download-unavailable', 1, 1, 'Сборка недоступна'],
    ],
    edges: [
      ['a', 'b', '«Скачать Cord»'],
      ['b', 'c', '«Скачать установщик»'],
      ['c', 'd', 'ярлык на рабочем столе'],
      ['d', 'e', 'новее нет'],
      ['b', 'f', 'манифеста нет'],
    ],
  },
  chat: {
    title: '13 · Чат и файл',
    note: 'Чат и файлы — в правой панели встречи; на телефоне — нижний лист через «ещё».',
    nodes: [
      ['a', 'meeting-grid', 0, 0, 'Встреча'],
      ['b', 'meeting-chat', 1, 0, 'Чат и файлы'],
      ['c', 'meeting-chat@360', 2, 0, 'Телефон: лист чата'],
    ],
    edges: [
      ['a', 'b', '«Чат»; файл — скрепкой или перетаскиванием'],
      ['b', 'c', 'то же на телефоне: «ещё» → «Чат и файлы»'],
    ],
  },
  // --- E15-B: новое после E15-A. Превью экранов, которых нет на странице «Как есть», кладутся PNG по
  // ответу (`pending`) — figma-svg-upload.mjs по nodeIds.
  telegram: {
    title: '14 · Telegram Mini App (T04, E09)',
    note: 'Создатель привязывает беседу в «Интеграциях»; бот закрепляет сообщение с кнопкой. Кнопка открывает Mini App на весь экран Telegram: связь, вход службы, микрофон — и та же встреча, что в браузере. Ошибки — экранами, не алертами.',
    nodes: [
      ['h', 'integrations-telegram', 0, 0, 'Интеграции → Telegram (создатель)'],
      ['i', 'box:Бот закрепляет в беседе сообщение с кнопкой «Открыть встречу»', 1, 0, 'Беседа'],
      ['b', 'tg-loading@360', 2, 0, 'Загрузка tg.html'],
      ['n', 'tg-meeting-note@360', 3, 0, 'Встреча + подсказка о фоне'],
      ['d', 'tg-meeting@360', 4, 0, 'Встреча в Telegram'],
      ['e', 'tg-failed@360', 2, 1, 'Отказ: не участник беседы'],
      ['f', 'tg-media@360', 3, 1, 'Нет микрофона'],
      ['g', 'tg-outside@360', 2, 2, 'Открыто не в Telegram'],
    ],
    edges: [
      ['h', 'i', '«Добавить бота в группу» / /bind <код>'],
      ['i', 'b', 'участник жмёт кнопку'],
      ['b', 'n', 'подпись initData верна, член беседы'],
      ['n', 'd', '«Скрыть подсказку»'],
      ['b', 'e', 'TELEGRAM_NOT_MEMBER / привязка отозвана'],
      ['b', 'f', 'микрофон запрещён'],
      ['f', 'd', 'войти без микрофона'],
      ['i', 'g', 'ссылку открыли в браузере'],
    ],
  },
  'phone-background': {
    title: '15 · Телефон: разговор в фоне (T16, E12)',
    note: 'Через 3 с после подключения — один раз на устройстве — честно, что будет, если свернуть браузер. «Свернуть в окно» — собеседник поверх других приложений. Вернулся — если телефон глушил микрофон, сказано, когда вас не слышали.',
    nodes: [
      ['a', 'meeting-solo@360', 0, 0, 'Встреча на телефоне'],
      ['b', 'background-android@360', 1, 0, 'Android: шторка «использует микрофон»'],
      ['c', 'background-ios@360', 1, 1, 'iPhone, Safari: оранжевая точка'],
      ['d', 'background-ios-home@360', 1, 2, 'iPhone, «Домой»: фона нет'],
      ['e', 'background-no-mic@360', 1, -1, 'Нет доступа к микрофону'],
      ['f', 'meeting-more-phone@360', 2, 0, '«…» → «Свернуть в окно»'],
      [
        'g',
        'box:Окно поверх приложений (картинка в картинке); свёрнутый браузер держит разговор',
        3,
        0,
        'В фоне',
      ],
      ['h', 'box:Вернулся на экран: «телефон выключал микрофон с … по …»', 4, 0, 'Возврат'],
    ],
    edges: [
      ['a', 'b', 'Android, микрофон есть'],
      ['a', 'c', 'iPhone в Safari'],
      ['a', 'd', 'с экрана «Домой»'],
      ['a', 'e', 'микрофон запрещён'],
      ['b', 'f', 'подсказку закрыл, «…»'],
      ['f', 'g', '«Свернуть в окно» / «Домой»'],
      ['g', 'h', 'вернулся в браузер'],
    ],
  },
  'electron-update': {
    title: '16 · Клиент на Electron: запуск, плашка обновления, окно (В-1, T58, T55)',
    note: 'Плашка 300×360 до приложения: проверка ≤ 5 с → загрузка с сервера Cord (подпись Ed25519, sha256) → установка → перезапуск. Дальше окно грузит веб («дышащий» знак) или говорит, что сервера нет.',
    nodes: [
      ['s', 'box:Запуск Cord', 0, 0, 'Запуск'],
      ['a', 'electron-splash-checking@300', 1, 0, 'Проверяем обновления…'],
      ['b', 'electron-splash-downloading@300', 2, 0, 'Загружаем… 42%'],
      ['c', 'electron-splash-installing@300', 3, 0, 'Устанавливаем…'],
      ['r', 'box:Тихая установка и перезапуск новой версии', 4, 0, 'Перезапуск'],
      ['l', 'electron-loading@1180', 2, 1, 'Окно: загрузка интерфейса'],
      ['h', 'electron-home@1440', 3, 1, 'Главная в клиенте'],
      ['f', 'electron-splash-failed@300', 3, 2, 'Сбой: «Повторить» / «Открыть Cord»'],
      ['o', 'electron-offline@1180', 3, -1, 'Нет связи с сервером'],
    ],
    edges: [
      ['s', 'a', 'плашка до приложения'],
      ['a', 'b', 'есть новее'],
      ['b', 'c', 'пакет проверен'],
      ['c', 'r', 'установщик готов'],
      ['a', 'l', 'новее нет / 5 с тишины'],
      ['l', 'h', 'веб загрузился'],
      ['l', 'o', 'сервер не отвечает'],
      ['b', 'f', 'минута тишины / подпись не сошлась'],
      ['f', 'l', '«Открыть Cord»'],
    ],
  },
  'electron-capture': {
    title: '17 · Клиент: показ экрана, оверлей, серверы (T10, T23, T05)',
    note: 'В клиенте источник показа выбирают своим окном до getDisplayMedia; оверлей поверх игры показывает, кто говорит; серверы — только каталог Cord с пингом.',
    nodes: [
      ['h', 'electron-home@1440', 0, 0, 'Главная в клиенте'],
      ['m', 'meeting-grid', 1, 0, 'Встреча'],
      ['p', 'electron-picker-screen@760', 2, 0, '«Что показать»: экраны'],
      ['w', 'electron-picker-window@760', 3, 1, 'Вкладка «Окно»'],
      ['s', 'meeting-screen', 3, 0, 'Экран у всех'],
      ['o', 'electron-overlay@320', 2, 1, 'Оверлей поверх игры'],
      ['v', 'electron-servers@440', 1, -1, 'Серверы'],
    ],
    edges: [
      ['h', 'm', '«Новая встреча» → «Начать»'],
      ['m', 'p', '«Показать экран»'],
      ['p', 's', 'выбрал экран, «Показать»'],
      ['p', 'w', 'вкладка «Окно»'],
      ['m', 'o', 'запустил игру во весь экран'],
      ['h', 'v', 'меню клиента → «Серверы»'],
    ],
  },
  'platform-choice': {
    title: '18 · Выбор площадки: музыка и кинозал (T59)',
    note: 'И в музыку, и в кинозал — каждый раз через выбор площадки; прошлый выбор отмечен «Последний выбор» и получает фокус. Площадки — только включённые на сервере.',
    nodes: [
      ['a', 'meeting-integrations', 0, 0, 'Панель «Интеграции»'],
      ['b', 'music-picker', 1, 0, 'Музыка: выберите площадку'],
      ['c', 'music-youtube', 2, 0, 'Музыка · YouTube'],
      ['d', 'music-files', 3, 0, 'Свои файлы'],
      ['e', 'cinema-picker', 1, 1, 'Кинозал: выберите площадку'],
      ['f', 'cinema-catalog', 2, 1, 'Каталог YouTube'],
      ['g', 'cinema-player', 3, 1, 'Смотреть вместе'],
    ],
    edges: [
      ['a', 'b', '«Музыка»'],
      ['b', 'c', 'плитка YouTube'],
      ['c', 'd', 'вкладка «Свои файлы» (плеер и очередь те же)'],
      ['a', 'e', '«Кинозал»'],
      ['e', 'f', 'плитка YouTube'],
      ['f', 'g', '«Смотреть вместе»'],
    ],
  },
};

if (args.list) {
  for (const [id, flow] of Object.entries(FLOWS)) console.log(`${id} — ${flow.title}`);
  process.exit(0);
}

const SPLASH = { Проверка: '5:2', Загрузка: '5:14', Установка: '5:26', Сбой: '5:38' };
const wanted = args.flows.split(',');
const flows = wanted.map((id) => {
  const flow = FLOWS[id];
  return {
    id,
    title: flow.title,
    note: flow.note,
    edges: flow.edges,
    nodes: flow.nodes.map(([key, state, col, row, label]) => {
      if (state.startsWith('splash:'))
        return { key, kind: 'splash', ref: SPLASH[state.slice(7)], col, row, label };
      if (state.startsWith('box:')) return { key, kind: 'box', text: state.slice(4), col, row, label };
      const [id, width = '1440'] = state.split('@');
      // Окна клиента своих размеров: превью той же высоты, что телефон, или той же ширины, что стол.
      const DIMS = { 300: [282, 338], 320: [300, 338], 440: [286, 338], 760: [432, 318], 1180: [432, 278] };
      return {
        key,
        kind: 'shot',
        ref: `${id} / ${width} / dark`,
        dims: DIMS[width] ?? null,
        width,
        mobile: width === '360',
        col,
        row,
        label,
        state: id,
      };
    }),
  };
});

const code = `
const FLOWS = ${JSON.stringify(flows)};
const page = figma.root.children.find((p) => p.name === 'Флоу');
// Превью — та же картинка, что в кадре страницы «Как есть»: кадр ищется по имени «id / ширина / тема».
const asis = figma.root.children.find((p) => p.name.startsWith('Как есть'));
await asis.loadAsync();
const byName = new Map(asis.findAllWithCriteria({ types: ['FRAME'] }).filter((n) => n.name.includes(' / ')).map((n) => [n.name, n]));
await figma.setCurrentPageAsync(page);
await Promise.all(['Regular', 'Medium', 'Semi Bold', 'Bold'].map((style) => figma.loadFontAsync({ family: 'Inter', style })));
const ink = { r: 0.067, g: 0.078, b: 0.098 }, muted = { r: 0.38, g: 0.42, b: 0.48 }, blue = { r: 0.208, g: 0.392, b: 0.953 };
const text = (chars, size, style, color = ink, width) => {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style };
  t.fontSize = size;
  t.characters = chars;
  t.fills = [{ type: 'SOLID', color }];
  if (width) { t.resize(width, t.height); t.textAutoResize = 'HEIGHT'; }
  return t;
};
const TW = 432, TH = 270, MW = 156, MH = 338, GAP = 300, ROW = 470, PAD = 120, TOP = 360;
const out = [];
const pending = [];
const starts = [];
let y0 = ${args.y ?? 'Math.max(0, ...page.children.filter((n) => n.type === "SECTION").map((n) => n.y + n.height)) + 300'};
for (const flow of FLOWS) {
  // Пересборка встаёт на прежнее место, новый флоу — под остальными.
  const old = page.children.find((n) => n.type === 'SECTION' && n.name === flow.title);
  const at = old ? old.y : y0;
  old?.remove();
  const section = figma.createSection();
  section.name = flow.title;
  section.x = 0; section.y = at;
  const head = text(flow.title, 64, 'Bold'); section.appendChild(head); head.x = PAD; head.y = 100;
  const note = text(flow.note, 24, 'Regular', muted, 2200); section.appendChild(note); note.x = PAD; note.y = 196;
  const minRow = Math.min(...flow.nodes.map((n) => n.row));
  const box = {};
  const nodeIds = {};
  for (const n of flow.nodes) {
    const x = PAD + n.col * (TW + GAP), y = TOP + (n.row - minRow) * ROW;
    let node;
    if (n.kind === 'shot') {
      const src = byName.get(n.ref);
      node = figma.createFrame();
      node.name = n.state + ' · ' + n.width + ' · тёмная';
      const w = n.dims ? n.dims[0] : n.mobile ? MW : TW, h = n.dims ? n.dims[1] : n.mobile ? MH : TH;
      node.resize(w, h);
      node.cornerRadius = n.mobile ? 16 : 8;
      node.clipsContent = true;
      const fill = src && Array.isArray(src.fills) ? src.fills.find((f) => f.type === 'IMAGE') : null;
      node.fills = fill ? [{ type: 'IMAGE', imageHash: fill.imageHash, scaleMode: 'FILL' }] : [{ type: 'SOLID', color: { r: 0.85, g: 0.86, b: 0.88 } }];
      if (!fill) pending.push({ node: node.id, png: n.state + '-' + n.width + '-dark.png' });
      node.effects = [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.16 }, offset: { x: 0, y: 6 }, radius: 24, spread: 0, visible: true, blendMode: 'NORMAL' }];
      node.x = x + (TW - w) / 2; node.y = y + (MH - h) / 2;
    } else if (n.kind === 'splash') {
      const comp = await figma.getNodeByIdAsync(n.ref);
      node = comp.createInstance();
      node.rescale(0.9);
      node.x = x + (TW - node.width) / 2; node.y = y + (MH - node.height) / 2;
    } else {
      node = figma.createAutoLayout('VERTICAL', { name: 'Шаг вне браузера', primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER' });
      node.resize(TW, 140);
      node.primaryAxisSizingMode = 'FIXED'; node.counterAxisSizingMode = 'FIXED';
      node.cornerRadius = 16; node.paddingLeft = 24; node.paddingRight = 24;
      node.fills = [{ type: 'SOLID', color: { r: 0.95, g: 0.96, b: 0.98 } }];
      node.strokes = [{ type: 'SOLID', color: { r: 0.8, g: 0.82, b: 0.86 } }]; node.dashPattern = [8, 6]; node.strokeWeight = 2;
      const t = text(n.text, 22, 'Medium', ink, TW - 48); t.textAlignHorizontal = 'CENTER';
      section.appendChild(node); node.appendChild(t);
      node.x = x; node.y = y + (MH - 140) / 2;
    }
    if (node.parent !== section) section.appendChild(node);
    const cap = text(n.label, 22, 'Semi Bold', ink, TW);
    cap.textAlignHorizontal = 'CENTER';
    section.appendChild(cap); cap.x = x; cap.y = node.y + node.height + 16;
    if (n.kind === 'shot') { const sub = text(n.state, 16, 'Regular', muted, TW); sub.textAlignHorizontal = 'CENTER'; section.appendChild(sub); sub.x = x; sub.y = cap.y + cap.height + 4; }
    box[n.key] = { x: node.x, y: node.y, w: node.width, h: node.height, col: n.col, row: n.row, cx: x + TW / 2 };
    nodeIds[n.key] = node.id;
  }
  for (const [from, to, label] of flow.edges) {
    const a = box[from], b = box[to];
    let pts;
    const ay = a.y + a.h / 2, by = b.y + b.h / 2;
    if (b.col > a.col) {
      const x1 = a.x + a.w + 12, x2 = b.x - 12;
      // Через колонку — вертикаль у цели, чтобы горизонталь шла по пустому ряду источника, а не
      // поперёк экранов промежуточной колонки.
      const mid = b.col - a.col > 1 ? b.x - 60 : PAD + a.col * (TW + GAP) + TW + 60;
      pts = Math.abs(ay - by) < 2 ? [[x1, ay], [x2, by]] : [[x1, ay], [mid, ay], [mid, by], [x2, by]];
    } else if (b.col === a.col) {
      const down = b.row > a.row;
      pts = down ? [[a.cx, a.y + a.h + 70], [b.cx, b.y - 12]] : [[a.cx, a.y - 12], [b.cx, b.y + b.h + 70]];
    } else {
      const yb = Math.max(a.y + a.h, b.y + b.h) + 90;
      pts = [[a.cx, a.y + a.h + 70], [a.cx, yb], [b.cx, yb], [b.cx, b.y + b.h + 70]];
    }
    const minX = Math.min(...pts.map((p) => p[0])), minY = Math.min(...pts.map((p) => p[1]));
    const v = figma.createVector();
    v.name = 'стрелка ' + from + '→' + to;
    await v.setVectorNetworkAsync({
      vertices: pts.map(([px, py], i) => ({ x: px - minX, y: py - minY, strokeCap: i === pts.length - 1 ? 'ARROW_LINES' : 'NONE', strokeJoin: 'ROUND', cornerRadius: 16 })),
      segments: pts.slice(1).map((_, i) => ({ start: i, end: i + 1 })),
      regions: [],
    });
    v.strokes = [{ type: 'SOLID', color: blue }];
    v.strokeWeight = 3;
    section.appendChild(v); v.x = minX; v.y = minY;
    // Подпись — у первого горизонтального отрезка (или у вертикального справа).
    const lab = figma.createAutoLayout('HORIZONTAL', { name: 'действие ' + from + '→' + to });
    lab.paddingLeft = 10; lab.paddingRight = 10; lab.paddingTop = 6; lab.paddingBottom = 6; lab.cornerRadius = 8;
    lab.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    lab.strokes = [{ type: 'SOLID', color: { r: 0.82, g: 0.86, b: 0.97 } }]; lab.strokeWeight = 1;
    const lt = text(label, 17, 'Medium', ink, GAP - 110);
    section.appendChild(lab); lab.appendChild(lt);
    const [p0, p1] = pts;
    // Колено к другому ряду — подпись у середины вертикали: из одного экрана выходит несколько
    // веток, а в один экран входит несколько, и у концов подписи легли бы друг на друга.
    if (pts.length === 4 && b.col > a.col) { lab.x = b.col - a.col > 1 ? pts[1][0] - lab.width - 10 : pts[1][0] + 10; lab.y = (pts[1][1] + pts[2][1]) / 2 - lab.height / 2; }
    else if (p0[1] === p1[1]) { lab.x = Math.min(p0[0], p1[0]) + 8; lab.y = p0[1] - lab.height - 8; }
    else { lab.x = p0[0] + 12; lab.y = (p0[1] + p1[1]) / 2 - lab.height / 2; }
  }
  // Прототип: нажатие на экран ведёт по первой стрелке из него; флоу начинается с первого узла.
  const byKey = {};
  for (const n of flow.nodes) byKey[n.key] = section.children.find((c) => c.id === nodeIds[n.key]);
  const linked = new Set();
  for (const [from, to] of flow.edges) {
    const a = byKey[from], b = byKey[to];
    if (!a || !b || linked.has(from) || b.type !== 'FRAME') continue;
    await a.setReactionsAsync([{ actions: [{ type: 'NODE', destinationId: b.id, navigation: 'NAVIGATE', transition: { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.3 }, preserveScrollPosition: false }], trigger: { type: 'ON_CLICK' } }]);
    linked.add(from);
  }
  const start = byKey[flow.nodes[0].key];
  if (start && start.type === 'FRAME') starts.push({ nodeId: start.id, name: flow.title });
  const right = Math.max(...section.children.map((n) => n.x + n.width)), bottom = Math.max(...section.children.map((n) => n.y + n.height));
  section.resizeWithoutConstraints(right + PAD, bottom + PAD);
  out.push({ flow: flow.id, section: section.id, nodes: flow.nodes.length, edges: flow.edges.length, links: linked.size });
  if (at === y0) y0 += section.height + 300;
}
// Начала флоу — одним присваиванием, без повторов узлов.
let startError = null;
try {
  const keep = page.flowStartingPoints.filter((p) => !starts.some((s) => s.name === p.name || s.nodeId === p.nodeId));
  const seen = new Set();
  page.flowStartingPoints = [...keep, ...starts].filter((p) => !seen.has(p.nodeId) && seen.add(p.nodeId));
} catch (error) {
  startError = String(error);
}
return { out, pending: pending.map((p) => p.node + '=' + p.png).join(','), startError };
`;
process.stdout.write(code);
