#!/usr/bin/env python3
"""Схема архитектуры Cord для доски встречи (R238): `docs/architecture/cord-architecture.cord-board`.

Файл доски — JSON Excalidraw v2 с `source: "cord"`; открыть: встреча → «Доска рисования» → «Ещё» → «Открыть файл».

Владелец: «нарисуй архитектуру не как мешанину текста и связок, а так, чтобы было видно сколько ядер, как
взаимодействует, с какой БД, где Redis». Поэтому раскладка здесь ручная, а не автоматическая сетка:

- четыре рамки-места: машина ядра, медиаузлы, резерв с наблюдением, внешнее; в заголовке каждой — сколько машин;
- внутри машины ядра — три ряда сверху вниз: вход, службы, данные (PostgreSQL, Redis, файлы);
- связей мало, каждая подписана и идёт под прямым углом; медиа (жирная линия) нарисовано отдельно от управления;
- цвет — род вещи: зелёный — ядро, фиолетовый — службы, синий — данные, малиновый — медиа, серый — наблюдение.

usage: python3 scripts/arch-board/build.py [out.cord-board]
"""
import json
import random
import sys
import time

random.seed(11)
OUT = sys.argv[1] if len(sys.argv) > 1 else 'docs/architecture/cord-architecture.cord-board'
FONT = 6  # Nunito
NOW = int(time.time() * 1000)
elements = []
counter = [0]

PALETTE = {  # род → (обводка, заливка)
    'people': ('#1971c2', '#d0ebff'),
    'edge': ('#e8590c', '#fff4e6'),
    'core': ('#2f9e44', '#d3f9d8'),
    'service': ('#5f3dc4', '#e5dbff'),
    'data': ('#1864ab', '#e7f5ff'),
    'media': ('#c2255c', '#ffdeeb'),
    'monitor': ('#495057', '#f1f3f5'),
    'agent': ('#0c8599', '#c5f6fa'),
    'external': ('#868e96', '#ffffff'),
    'spare': ('#868e96', '#f8f9fa'),
}


def nid(prefix):
    counter[0] += 1
    return f'{prefix}{counter[0]:03d}'


def base(kind, x, y, w, h, **kw):
    e = {
        'id': kw.pop('id', None) or nid(kind[:2]), 'type': kind, 'x': round(x, 1), 'y': round(y, 1),
        'width': round(w, 1), 'height': round(h, 1), 'angle': 0, 'strokeColor': '#1e1e1e',
        'backgroundColor': 'transparent', 'fillStyle': 'solid', 'strokeWidth': 2, 'strokeStyle': 'solid',
        'roughness': 0, 'opacity': 100, 'groupIds': [], 'frameId': None, 'roundness': None,
        'seed': random.randrange(1, 2**31), 'version': 1, 'versionNonce': random.randrange(1, 2**31),
        'isDeleted': False, 'boundElements': [], 'updated': NOW, 'link': None, 'locked': False, 'index': None,
    }
    e.update(kw)
    elements.append(e)
    return e


def size_of(text, size):
    lines = text.split('\n')
    return max(len(line) for line in lines) * size * 0.56, len(lines) * size * 1.25


def text(x, y, body, size=18, color='#1e1e1e', frame=None, align='left'):
    w, h = size_of(body, size)
    return base('text', x, y, w, h, text=body, originalText=body, fontSize=size, fontFamily=FONT, textAlign=align,
                verticalAlign='top', containerId=None, autoResize=True, lineHeight=1.25, strokeColor=color,
                frameId=frame['id'] if frame else None)


def bound(container, body, size, color='#1e1e1e'):
    w, h = size_of(body, size)
    cx, cy = container['x'] + container['width'] / 2, container['y'] + container['height'] / 2
    label = base('text', cx - w / 2, cy - h / 2, w, h, text=body, originalText=body, fontSize=size, fontFamily=FONT,
                 textAlign='center', verticalAlign='middle', containerId=container['id'], autoResize=True,
                 lineHeight=1.25, strokeColor=color, frameId=container.get('frameId'))
    container['boundElements'].append({'id': label['id'], 'type': 'text'})
    return label


def frame(x, y, w, h, name, color='#adb5bd'):
    return base('frame', x, y, w, h, name=name, strokeWidth=1, strokeColor=color)


def box(fr, x, y, w, h, kind, title, detail='', shape='rectangle', dashed=False):
    stroke, fill = PALETTE[kind]
    el = base(shape, x, y, w, h, strokeColor=stroke, backgroundColor=fill, frameId=fr['id'] if fr else None,
              roundness={'type': 3} if shape == 'rectangle' else None, strokeStyle='dashed' if dashed else 'solid')
    bound(el, title + ('\n' + detail if detail else ''), 18)
    return el


def arrow(points, label='', color='#495057', thick=False, dashed=False, both=False, size=15):
    """Стрелка ломаной по точкам (прямые углы задаёт сам список точек)."""
    x0, y0 = points[0]
    rel = [[round(px - x0, 1), round(py - y0, 1)] for px, py in points]
    xs, ys = [p[0] for p in rel], [p[1] for p in rel]
    el = base('arrow', x0, y0, max(xs) - min(xs), max(ys) - min(ys), points=rel, lastCommittedPoint=None,
              startArrowhead='arrow' if both else None, endArrowhead='arrow', startBinding=None, endBinding=None,
              elbowed=False, strokeColor=color, strokeWidth=4 if thick else 2,
              strokeStyle='dashed' if dashed else 'solid', roundness=None)
    if label:
        bound(el, label, size, '#343a40')
    return el


# ── Заголовок ────────────────────────────────────────────────────────────────────────────────────────────────
text(0, -230, 'Архитектура Cord', 44)
text(0, -165, 'Целевая схема, ноябрь 2026 · одно активное ядро, один резерв, медиаузлы растут по одному · cord.online',
     20, '#495057')

# ── Люди ─────────────────────────────────────────────────────────────────────────────────────────────────────
PEOPLE_Y = -70
people = [
    box(None, 260, PEOPLE_Y, 300, 110, 'people', 'Браузер', 'cord.online', 'ellipse'),
    box(None, 620, PEOPLE_Y, 300, 110, 'people', 'Приложение Windows', 'Electron', 'ellipse'),
    box(None, 980, PEOPLE_Y, 300, 110, 'people', 'Телефон', 'Android, Telegram', 'ellipse'),
]

# ── Машина ядра ──────────────────────────────────────────────────────────────────────────────────────────────
CORE_X, CORE_Y, CORE_W, CORE_H = 0, 230, 1560, 800
core = frame(CORE_X, CORE_Y, CORE_W, CORE_H, 'Машина ядра · 1 шт.', '#2f9e44')
text(40, 250, 'Москва · выделенный сервер · 8–16 ядер, 64 ГБ, порт 1 Гбит/с', 16, '#868e96', core)
gate = box(core, 40, 300, 1480, 90, 'edge', 'Вход: edge → шлюз (Caddy)', 'порт 443 · TLS · сжатие · статика приложения')
text(40, 425, 'Службы', 16, '#868e96', core)
k_core = box(core, 40, 455, 430, 150, 'core', 'Ядро Cord — 1 активное',
             'Java 25 · комнаты, вход, права, игры,\nвыбор узла, защита от роботов')
k_insight = box(core, 500, 455, 300, 150, 'service', 'insight', 'Rust · аналитика:\nлюди, роботы, ошибки')
k_services = box(core, 830, 455, 430, 150, 'service', 'Службы',
                 'Python и Go · кинозал, музыка,\nбот и приложение Telegram')
k_agent = box(core, 1290, 455, 230, 150, 'agent', 'cord-agent', 'Rust · рычаги\nи метрики')
text(40, 660, 'Данные', 16, '#868e96', core)
d_pg = box(core, 40, 690, 620, 150, 'data', 'PostgreSQL 18 — основная база',
           'встречи, избранное, журнал участников, обращения;\nотдельная схема — аналитика insight')
d_redis = box(core, 690, 690, 380, 150, 'data', 'Redis 8',
              'пределы частоты, «разбуди сокеты»,\nаренда фоновых задач')
d_files = box(core, 1100, 690, 350, 150, 'data', 'Файлы (tusd, том)', 'вложения чата, картинки\nдоски; живут ≤ суток')
text(190, 885, 'Медиаузла на этой машине нет: ядро и база не делят процессор со звуком, порт целиком у кинозала.\n'
              'Второе активное ядро не нужно до нескольких тысяч одновременных; до него — резерв ниже.', 16, '#495057', core)

# ── Медиаузлы ────────────────────────────────────────────────────────────────────────────────────────────────
MEDIA_X, MEDIA_Y, MEDIA_W, MEDIA_H = 1860, 230, 1240, 800
media = frame(MEDIA_X, MEDIA_Y, MEDIA_W, MEDIA_H, 'Медиаузлы · 5 шт., растут по одному', '#c2255c')
text(MEDIA_X + 40, 250, 'VPS с 4 выделенными ядрами · два провайдера в России, один узел в Европе · +1 узел на +100 человек', 16, '#868e96', media)
NODES = [('Москва-1', 'провайдер А'), ('Москва-2', 'провайдер А'), ('Москва-3', 'провайдер Б'),
         ('Петербург-1', 'провайдер Б'), ('Европа-1', 'Франкфурт или Хельсинки')]
node_boxes = []
for i, (name, where) in enumerate(NODES):
    col, row = i % 3, i // 3
    node_boxes.append(box(media, MEDIA_X + 40 + col * 393, 300 + row * 200, 363, 150, 'media', name,
                          where + '\nLiveKit SFU + TURN\nedge · cord-agent'))
box(media, MEDIA_X + 40 + 2 * 393, 500, 363, 150, 'spare', '+ следующий узел',
    'строка в infra/dns/zones.json,\nкоманда и агент', dashed=True)
text(MEDIA_X + 40, 720, 'Встреча живёт на одном узле целиком. Узел выбирается по замеру человека и по нагрузке;\n'
                        'упавший узел — встречи переезжают на соседний за секунды. Состояния на узле нет.\n'
                        'Каждый узел: порт 443 (сигнал и TURN по TLS), UDP 7882 и 3478, TCP 7881.', 16, '#495057', media)

# ── Резерв и наблюдение ─────────────────────────────────────────────────────────────────────────────────────
SPARE_Y, SPARE_H = 1250, 420
spare = frame(0, SPARE_Y, CORE_W, SPARE_H, 'Резерв и наблюдение · 1 шт.', '#495057')
text(40, SPARE_Y + 22, 'другой провайдер и другой дата-центр · VPS, 4 выделенных ядра, 8 ГБ', 16, '#868e96', spare)
s_pg = box(spare, 40, SPARE_Y + 80, 400, 150, 'data', 'PostgreSQL — копия', 'потоковая репликация;\nночные копии')
s_core = box(spare, 470, SPARE_Y + 80, 300, 150, 'spare', 'Ядро наготове', 'тот же образ, остановлено;\nподъём за минуты', dashed=True)
s_mon = box(spare, 800, SPARE_Y + 80, 360, 150, 'monitor', 'Наблюдение', 'VictoriaMetrics, оповещения,\nGrafana, внешняя проба')
s_fleet = box(spare, 1190, SPARE_Y + 80, 330, 150, 'agent', 'Пульт', 'fleet + веб пульта:\nкарта флота, аналитика, рычаги')
text(40, SPARE_Y + 275, 'Ядро упало — здесь поднимается резерв, а запись cord.online переключается за минуту.\n'
                        'Оповещение о падении приходит отсюда, потому что эта машина не падает вместе с ядром.', 16, '#495057', spare)

# ── Вне наших машин ─────────────────────────────────────────────────────────────────────────────────────────
ext = frame(MEDIA_X, SPARE_Y, MEDIA_W, SPARE_H, 'Вне наших машин', '#868e96')
e_owner = box(ext, MEDIA_X + 40, SPARE_Y + 80, 363, 150, 'people', 'Владелец', 'браузер, вход в пульт\nпо сертификату', 'ellipse')
e_dns = box(ext, MEDIA_X + 433, SPARE_Y + 80, 363, 150, 'external', 'Cloudflare', 'DNS и регистратор cord.online;\nзаписи — файлом в репозитории', dashed=True)
e_sites = box(ext, MEDIA_X + 826, SPARE_Y + 80, 363, 150, 'external', 'Площадки кинозала', 'YouTube (через Европу-1), Rutube,\nVK, ivi — кинозал качает сам', dashed=True)
text(MEDIA_X + 40, SPARE_Y + 275, 'Цвета: зелёный — ядро, фиолетовый — службы, синий — данные, малиновый — медиа,\n'
                                  'бирюзовый — управление, серый — наблюдение. Жирная линия — звук и видео.', 16, '#495057', ext)

# ── Связи ────────────────────────────────────────────────────────────────────────────────────────────────────
MID_PEOPLE = PEOPLE_Y + 110
# 1. Люди → вход ядра: всё, кроме медиа.
arrow([(770, MID_PEOPLE + 8), (770, 292)], 'HTTPS и WebSocket:\nвход, события, чат', '#e8590c')
# 2. Люди → медиаузлы: звук и видео напрямую.
arrow([(1285, PEOPLE_Y + 55), (2480, PEOPLE_Y + 55), (2480, 292)], 'WebRTC: звук и видео —\nнапрямую на узел встречи', '#c2255c', thick=True)
# 3. Ядро ↔ медиаузлы: управление.
arrow([(CORE_X + CORE_W + 10, 530), (MEDIA_X - 10, 530)], 'управление по mTLS:\nтокены, состояние,\nпереезд встреч', '#2f9e44', both=True)
# 4. Внутри машины ядра: вход → службы, службы → данные.
arrow([(255, 392), (255, 451)], color='#e8590c')
arrow([(650, 392), (650, 451)], color='#e8590c')
arrow([(1045, 392), (1045, 451)], color='#e8590c')
arrow([(200, 607), (200, 686)], color='#1864ab')
arrow([(400, 607), (400, 640), (880, 640), (880, 686)], color='#1864ab')
arrow([(600, 607), (600, 686)], color='#1864ab')
arrow([(1150, 607), (1150, 640), (1275, 640), (1275, 686)], color='#1864ab')
arrow([(472, 530), (497, 530)], color='#5f3dc4')
# 5. База → копия.
arrow([(110, 842), (110, SPARE_Y + 76)], 'репликация\nв реальном времени', '#1864ab')
# 6. Агенты → пульт: только исходящие.
arrow([(1490, 607), (1490, SPARE_Y + 76)], 'агенты приходят сами:\nзадания и метрики (HTTPS)', '#0c8599', dashed=True)
arrow([(MEDIA_X + 220, 1032), (MEDIA_X + 220, 1140), (1420, 1140), (1420, SPARE_Y + 76)], color='#0c8599', dashed=True)
# 7. Владелец → пульт.
arrow([(MEDIA_X + 36, SPARE_Y + 155), (1524, SPARE_Y + 155)], color='#1971c2')
elements.sort(key=lambda e: 0 if e['type'] == 'frame' else 1)
doc = {'type': 'excalidraw', 'version': 2, 'source': 'cord', 'elements': elements,
       'appState': {'viewBackgroundColor': '#ffffff', 'gridSize': None}, 'files': {}}
json.dump(doc, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'{len(elements)} элементов → {OUT}', file=sys.stderr)
