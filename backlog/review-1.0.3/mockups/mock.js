/* Общий скрипт макетов: тема, панель, сегменты, ползунки, переключатели, вкладки, модальность ввода. Без зависимостей. */
(function () {
  const q = new URLSearchParams(location.search);
  const root = document.documentElement;
  const theme = q.get('theme');
  if (theme) { root.dataset.theme = theme; root.dataset.shot = '1'; }
  else if (!root.dataset.theme) root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (q.get('desktop') === '1') root.dataset.desktop = 'true';
  if (q.get('view')) root.dataset.view = q.get('view');
  root.dataset.input = 'pointer';

  // модальность ввода (S1)
  const NAV = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'F6']);
  addEventListener('pointerdown', () => { root.dataset.input = 'pointer'; }, true);
  addEventListener('keydown', (e) => { if (NAV.has(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) root.dataset.input = 'keyboard'; }, true);

  // спрайт значков (контуры в духе lucide, stroke 1.75)
  const icons = {
    mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/>',
    'mic-off': '<path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M15 9.3V6a3 3 0 0 0-5.9-.8"/><path d="M19 11a7 7 0 0 1-.9 3.4M5 11a7 7 0 0 0 11.4 5.4"/><path d="M12 18v3"/><path d="M3 3l18 18"/>',
    video: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
    'video-off': '<path d="M10.7 7H14a2 2 0 0 1 2 2v3.3"/><path d="M16 16v-1l5 3V7l-3 2"/><path d="M3 7h1a2 2 0 0 0-1 2v6a2 2 0 0 0 2 2h9"/><path d="m3 3 18 18"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    'monitor-up': '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="m9 11 3-3 3 3M12 8v5"/>',
    'monitor-x': '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="m9.5 7.5 5 5M14.5 7.5l-5 5"/>',
    'phone-off': '<path d="M10.7 13.3a13 13 0 0 1-2.4-3.5l1.6-1.6a1 1 0 0 0 .2-1L9 3.6a1 1 0 0 0-1-.6H5a2 2 0 0 0-2 2 16 16 0 0 0 5.7 11.3"/><path d="M22 16.9v3.1a2 2 0 0 1-2 2 16 16 0 0 1-6.6-1.6"/><path d="m2 2 20 20"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3 16a2 2 0 0 1 3-3l1 1"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M17 14.5a6 6 0 0 1 4 5.5"/>',
    message: '<path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.4-4.2A8 8 0 1 1 21 12Z"/>',
    music: '<path d="M9 18V6l12-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    gamepad: '<path d="M6 11h4M8 9v4"/><path d="M15 12h.01M18 10h.01"/><path d="M17.3 5H6.7a4 4 0 0 0-4 3.6l-.7 7a2.5 2.5 0 0 0 4.4 1.9L8.5 15h7l2.1 2.5a2.5 2.5 0 0 0 4.4-1.9l-.7-7a4 4 0 0 0-4-3.6Z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m6 15 6-6 6 6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9Z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    headset: '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M3 14a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M21 14a2 2 0 0 0-2-2h-1a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2Z"/><path d="M21 17v1a3 3 0 0 1-3 3h-4"/>',
    pin: '<path d="M12 17v5"/><path d="M9 11V4h6v7l2 2v2H7v-2Z"/>',
    'pin-off': '<path d="M12 17v5"/><path d="M15 9.3V4H9v1"/><path d="M7 15h10v-2l-2-2"/><path d="m3 3 18 18"/>',
    more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
    play: '<path d="M7 4v16l13-8Z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    'skip-back': '<path d="M19 20 9 12l10-8Z"/><path d="M5 19V5"/>',
    'skip-forward': '<path d="m5 4 10 8-10 8Z"/><path d="M19 5v14"/>',
    shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.8-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    volume: '<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>',
    'list-music': '<path d="M3 6h12M3 12h12M3 18h7"/><circle cx="18" cy="17" r="2.5"/><path d="M20.5 17V9l3-1"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    square: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".9"/><circle cx="17.5" cy="10.5" r=".9"/><circle cx="8.5" cy="7.5" r=".9"/><circle cx="6.5" cy="12.5" r=".9"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.7-.7 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.7 1.7-1.7H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.4-10-8.4Z"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M7 17h10"/>',
    window: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20M7 6.5h.01M10 6.5h.01"/>',
    server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01M6 17.5h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 13A8 8 0 1 1 11 3a6.5 6.5 0 0 0 10 10Z"/>',
    grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>',
    spade: '<path d="M12 3C9 7 4 9.5 4 14a4 4 0 0 0 7 2.6c-.3 1.6-1 3-2 4.4h6c-1-1.4-1.7-2.8-2-4.4A4 4 0 0 0 20 14c0-4.5-5-7-8-11Z"/>',
    layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M10 10v10"/>',
    'circle-dot': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    flag: '<path d="M4 22V4a1 1 0 0 1 1-1h11l-1.5 4L16 11H5"/>',
    tv: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="m8 2 4 4 4-4"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .4-9A7 7 0 0 0 4.3 12 4 4 0 0 0 6 19Z"/>',
    'file-audio': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M10 17v-4l4-1v4"/><circle cx="9" cy="17.5" r="1.3"/><circle cx="13" cy="16.5" r="1.3"/>',
    heart: '<path d="M19.5 12.6 12 20l-7.5-7.4a4.5 4.5 0 0 1 6.4-6.4L12 7.3l1.1-1.1a4.5 4.5 0 0 1 6.4 6.4Z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    'corner-tl': '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="6" width="6" height="6" rx="1" fill="currentColor"/>',
    'corner-tr': '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="12" y="6" width="6" height="6" rx="1" fill="currentColor"/>',
    'corner-bl': '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="12" width="6" height="6" rx="1" fill="currentColor"/>',
    'corner-br': '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="12" y="12" width="6" height="6" rx="1" fill="currentColor"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    yandex: '<path d="M13.5 20V4h-2a4 4 0 0 0-1.5 7.7L7 20"/><path d="M13.5 12 9.9 11.7"/>',
    youtube: '<path d="M21 8.5c-.2-1.3-.9-2-2.2-2.2C17.2 6 12 6 12 6s-5.2 0-6.8.3C3.9 6.5 3.2 7.2 3 8.5 2.8 10 2.8 12 2.8 12s0 2 .2 3.5c.2 1.3.9 2 2.2 2.2 1.6.3 6.8.3 6.8.3s5.2 0 6.8-.3c1.3-.2 2-.9 2.2-2.2.2-1.5.2-3.5.2-3.5s0-2-.2-3.5Z"/><path d="m10 9.5 5 2.5-5 2.5Z" fill="currentColor"/>',
    soundcloud: '<path d="M4 15v2M6.5 13v4M9 12v5M11.5 10v7"/><path d="M14 9.5a4 4 0 0 1 7 2.6 2.5 2.5 0 0 1-.5 4.9H14Z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    telegram: '<path d="m21 4-4 16-6-4-3 3v-5l9-8-11 7-4-2Z"/>',
    'help-circle': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7"/><path d="M12 17h.01"/>',
    activity: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    power: '<path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    'maximize-2': '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    'minimize-2': '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
    'external': '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    bug: '<path d="M8 2l1.9 1.9M16 2l-1.9 1.9"/><path d="M9 7.5V7a3 3 0 0 1 6 0v.5"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v3c0 3.3-2.7 6-6 6Z"/><path d="M12 20v-9M6 13H2M22 13h-4M7 17l-3 2M17 17l3 2M7 9 4 7M17 9l3-2"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    'arrow-up-right': '<path d="M7 17 17 7M8 7h9v9"/>',
    download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
    paperclip: '<path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8-8"/>',
  };
  const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.setAttribute('style', 'display:none');
  sprite.innerHTML = Object.entries(icons).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('');
  document.body.prepend(sprite);

  // панель макета
  const bar = document.createElement('div');
  bar.className = 'mock-bar';
  bar.innerHTML = `<button data-t="light">Светлая</button><button data-t="dark">Тёмная</button>`;
  document.body.append(bar);
  const sync = () => bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === root.dataset.theme)));
  bar.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { root.dataset.theme = b.dataset.t; sync(); } });
  sync();

  // сегменты
  function placeSeg(seg) {
    const on = seg.querySelector('[aria-checked="true"]');
    if (!on) return;
    seg.style.setProperty('--seg-x', on.offsetLeft + 'px');
    seg.style.setProperty('--seg-w', on.offsetWidth + 'px');
  }
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.querySelectorAll('.seg__item').forEach((it) => {
      if (!it.hasAttribute('role')) it.setAttribute('role', 'radio');
      if (!it.hasAttribute('aria-checked')) it.setAttribute('aria-checked', 'false');
      it.addEventListener('click', () => {
        if (it.disabled) return;
        seg.querySelectorAll('.seg__item').forEach((o) => o.setAttribute('aria-checked', 'false'));
        it.setAttribute('aria-checked', 'true');
        placeSeg(seg);
        seg.dispatchEvent(new CustomEvent('segchange', { detail: it.dataset.value || it.textContent.trim() }));
      });
    });
    seg.addEventListener('keydown', (e) => {
      const items = [...seg.querySelectorAll('.seg__item:not([disabled])')];
      const i = items.findIndex((x) => x.getAttribute('aria-checked') === 'true');
      let n = i;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % items.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = items.length - 1; else return;
      e.preventDefault(); items[n].click(); items[n].focus();
    });
    placeSeg(seg);
    new ResizeObserver(() => placeSeg(seg)).observe(seg);
  });
  requestAnimationFrame(() => document.querySelectorAll('.seg').forEach(placeSeg));
  document.fonts && document.fonts.ready.then(() => document.querySelectorAll('.seg').forEach(placeSeg));

  // ползунки
  document.querySelectorAll('.slider input[type=range]').forEach((r) => {
    const out = r.closest('.slider').querySelector('.slider__value');
    const fmt = r.dataset.format || '%';
    const upd = () => {
      const p = (r.value - r.min) / (r.max - r.min);
      r.style.setProperty('--p', p);
      if (out) out.textContent = fmt === 'time' ? `${Math.floor(r.value / 60)}:${String(r.value % 60).padStart(2, '0')}` : `${r.value}${fmt === '%' ? ' %' : fmt}`;
    };
    r.addEventListener('input', upd); upd();
  });

  // переключатели
  document.querySelectorAll('.sw[role=switch]').forEach((s) => {
    s.addEventListener('click', () => { if (s.disabled) return; s.setAttribute('aria-checked', String(s.getAttribute('aria-checked') !== 'true')); });
  });
  document.querySelectorAll('.sw-row').forEach((row) => {
    row.addEventListener('click', (e) => { if (e.target.closest('.sw')) return; const s = row.querySelector('.sw'); s && s.click(); });
  });
  // чипы
  document.querySelectorAll('.chip[role=checkbox]').forEach((c) => c.addEventListener('click', () => c.setAttribute('aria-checked', String(c.getAttribute('aria-checked') !== 'true'))));
  document.querySelectorAll('.chip[role=radio]').forEach((c) => c.addEventListener('click', () => { c.parentElement.querySelectorAll('.chip[role=radio]').forEach((o) => o.setAttribute('aria-checked', 'false')); c.setAttribute('aria-checked', 'true'); }));
  // кнопки-состояния
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))));

  // вкладки/виды: [data-tabs] > [data-tab=x] переключает [data-pane=x]
  document.querySelectorAll('[data-tabs]').forEach((tabs) => {
    const scope = tabs.closest('[data-tabs-scope]') || document;
    const show = (name) => {
      tabs.querySelectorAll('[data-tab]').forEach((t) => { const on = t.dataset.tab === name; t.setAttribute('aria-selected', String(on)); if (t.classList.contains('seg__item')) t.setAttribute('aria-checked', String(on)); });
      scope.querySelectorAll('[data-pane]').forEach((p) => { if ((p.closest('[data-tabs-scope]') || document) !== scope) return; p.hidden = p.dataset.pane !== name; });
      if (tabs.classList.contains('seg')) placeSeg(tabs);
    };
    tabs.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
    const init = tabs.querySelector('[aria-selected="true"],[aria-checked="true"]') || tabs.querySelector('[data-tab]');
    if (init) show(init.dataset.tab);
  });

  // области прокрутки: data-scrolling на 800 мс, data-scrolled на обёртке
  document.querySelectorAll('.scroll-quiet').forEach((el) => {
    let t;
    el.addEventListener('scroll', () => {
      el.dataset.scrolling = '1'; clearTimeout(t); t = setTimeout(() => delete el.dataset.scrolling, 800);
      const host = el.closest('[data-scroll-host]'); if (host) host.toggleAttribute('data-scrolled', el.scrollTop > 2);
    }, { passive: true });
  });

  window.mock = { placeSeg };
})();
