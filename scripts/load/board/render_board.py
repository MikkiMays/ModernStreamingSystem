#!/usr/bin/env python3
"""diagram.json → файл доски Cord (.cord-board, он же JSON Excalidraw v2).

Группы — рамки (frame) по сетке, узлы — прямоугольники/эллипсы с подписью внутри, связи — стрелки,
привязанные к узлам, с подписью на стрелке. Типы элементов — только те, что пускает доска Cord
(rectangle, ellipse, diamond, text, arrow, frame).

usage: render_board.py diagram.json out.cord-board [layout.json]
layout.json (необязательно): {"groups": {"gid": [col, row, colspan?]}, "cols": {"gid": node_columns}}
"""
import json, math, random, sys, time

random.seed(7)
src = json.load(open(sys.argv[1]))
out_path = sys.argv[2]
layout = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}

PALETTE = {  # kind → (stroke, fill)
    'client': ('#1971c2', '#d0ebff'), 'lb': ('#e8590c', '#ffe8cc'), 'edge': ('#e8590c', '#fff4e6'),
    'core': ('#2f9e44', '#d3f9d8'), 'media': ('#c2255c', '#ffdeeb'), 'turn': ('#9c36b5', '#f3d9fa'),
    'data': ('#1864ab', '#e7f5ff'), 'service': ('#5f3dc4', '#e5dbff'), 'cdn': ('#0c8599', '#c5f6fa'),
    'monitor': ('#495057', '#f1f3f5'), 'external': ('#868e96', '#ffffff'),
}
FONT = 6  # Nunito — читается лучше рукописного на схеме
NODE_W, NODE_H, GAP_X, GAP_Y = 250, 96, 40, 44
PAD, TITLE_H, GROUP_GAP = 36, 44, 200
now = int(time.time() * 1000)
elements = []
counter = [0]


def nid(prefix):
    counter[0] += 1
    return f'{prefix}{counter[0]:04d}'


def base(kind, x, y, w, h, **kw):
    e = {
        'id': kw.pop('id', None) or nid(kind[:2]), 'type': kind, 'x': round(x, 1), 'y': round(y, 1),
        'width': round(w, 1), 'height': round(h, 1), 'angle': 0, 'strokeColor': '#1e1e1e',
        'backgroundColor': 'transparent', 'fillStyle': 'solid', 'strokeWidth': 2, 'strokeStyle': 'solid',
        'roughness': 0, 'opacity': 100, 'groupIds': [], 'frameId': None, 'roundness': None,
        'seed': random.randrange(1, 2**31), 'version': 1, 'versionNonce': random.randrange(1, 2**31),
        'isDeleted': False, 'boundElements': [], 'updated': now, 'link': None, 'locked': False, 'index': None,
    }
    e.update(kw)
    elements.append(e)
    return e


def text_size(text, size):
    lines = text.split('\n')
    width = max(len(l) for l in lines) * size * 0.56
    return width, len(lines) * size * 1.25


def label(container, text, size=16, color='#1e1e1e'):
    w, h = text_size(text, size)
    cx = container['x'] + container['width'] / 2
    cy = container['y'] + container['height'] / 2
    t = base('text', cx - w / 2, cy - h / 2, w, h, text=text, originalText=text, fontSize=size, fontFamily=FONT,
             textAlign='center', verticalAlign='middle', containerId=container['id'], autoResize=True,
             lineHeight=1.25, strokeColor=color, frameId=container.get('frameId'))
    container['boundElements'].append({'id': t['id'], 'type': 'text'})
    return t


groups = src['groups']
gnodes = {g['id']: [n for n in src['nodes'] if n['group'] == g['id']] for g in groups}

# ── раскладка групп: сетка колонок; ширина колонки — по самой широкой группе в ней ──
pos = layout.get('groups', {})
cols_of = layout.get('cols', {})
auto_col = 0
cells = {}
for i, g in enumerate(groups):
    if g['id'] in pos:
        c, r = pos[g['id']][:2]
    else:
        c, r = i % 3, i // 3
    span = pos.get(g['id'], [0, 0, 1])[2] if len(pos.get(g['id'], [])) > 2 else 1
    k = cols_of.get(g['id'], 2 if len(gnodes[g['id']]) > 3 else 1)
    k = max(1, min(k, len(gnodes[g['id']]) or 1))
    rows = math.ceil(len(gnodes[g['id']]) / k) if gnodes[g['id']] else 1
    nw, nh = NODE_W, NODE_H
    for n in gnodes[g['id']]:
        tw, th = text_size(n['label'], 15 if n['label'].count('\n') < 3 else 13)
        nw, nh = max(nw, tw + 36), max(nh, th + 30)
    w = PAD * 2 + k * nw + (k - 1) * GAP_X
    h = TITLE_H + PAD * 2 + rows * nh + (rows - 1) * GAP_Y
    cells[g['id']] = dict(c=c, r=r, span=span, k=k, w=w, h=h, nw=nw, nh=nh)
ncols = max(v['c'] + v['span'] for v in cells.values())
nrows = max(v['r'] for v in cells.values()) + 1
colw = [0] * ncols
rowh = [0] * nrows
for v in cells.values():
    if v['span'] == 1:
        colw[v['c']] = max(colw[v['c']], v['w'])
    rowh[v['r']] = max(rowh[v['r']], v['h'])
for v in cells.values():
    if v['span'] > 1:
        have = sum(colw[v['c']:v['c'] + v['span']]) + GROUP_GAP * (v['span'] - 1)
        if have < v['w']:
            colw[v['c'] + v['span'] - 1] += v['w'] - have
colx = [sum(colw[:i]) + GROUP_GAP * i for i in range(ncols)]
rowy = [sum(rowh[:i]) + GROUP_GAP * i for i in range(nrows)]

TITLE = src.get('title', 'Cord')
title = base('text', 0, -170, 10, 10, text=TITLE, originalText=TITLE, fontSize=40, fontFamily=FONT, textAlign='left',
             verticalAlign='top', containerId=None, autoResize=True, lineHeight=1.25)
title['width'], title['height'] = text_size(TITLE, 40)
if src.get('subtitle'):
    st = base('text', 0, -105, 10, 10, text=src['subtitle'], originalText=src['subtitle'], fontSize=20, fontFamily=FONT,
              textAlign='left', verticalAlign='top', containerId=None, autoResize=True, lineHeight=1.25, strokeColor='#495057')
    st['width'], st['height'] = text_size(src['subtitle'], 20)

node_el = {}
for g in groups:
    v = cells[g['id']]
    gw = sum(colw[v['c']:v['c'] + v['span']]) + GROUP_GAP * (v['span'] - 1)
    gh = rowh[v['r']]
    fx, fy = colx[v['c']], rowy[v['r']]
    short, _, detail = g['label'].partition(' (')
    frame = base('frame', fx, fy, gw, gh, id='fr' + g['id'][:60], name=short, strokeWidth=1, roughness=0)
    if g.get('color'):
        frame['strokeColor'] = g['color']
    if detail:
        detail = detail.rstrip(')')
        dt = base('text', fx + PAD, fy + 12, 10, 10, text=detail, originalText=detail, fontSize=16, fontFamily=FONT,
                  textAlign='left', verticalAlign='top', containerId=None, autoResize=True, lineHeight=1.25,
                  strokeColor='#868e96', frameId=frame['id'])
        dt['width'], dt['height'] = text_size(detail, 16)
    k = v['k']
    ns = gnodes[g['id']]
    NW, NH = v['nw'], v['nh']
    inner_w = k * NW + (k - 1) * GAP_X
    ox = fx + (gw - inner_w) / 2
    for j, n in enumerate(ns):
        cx, cy = j % k, j // k
        x = ox + cx * (NW + GAP_X)
        y = fy + TITLE_H + PAD + cy * (NH + GAP_Y)
        stroke, fill = PALETTE.get(n.get('kind', 'external'), PALETTE['external'])
        shape = 'ellipse' if n.get('kind') == 'client' else ('diamond' if n.get('kind') == 'lb' and n.get('diamond') else 'rectangle')
        el = base(shape, x, y, NW, NH, id='n' + n['id'][:60], strokeColor=stroke, backgroundColor=fill,
                  frameId=frame['id'], roundness={'type': 3} if shape == 'rectangle' else None,
                  strokeStyle='dashed' if n.get('kind') == 'external' else 'solid')
        label(el, n['label'], 15 if n['label'].count('\n') < 3 else 13)
        node_el[n['id']] = el


def border_point(el, tx, ty):
    """Точка на краю прямоугольника el по направлению к (tx, ty)."""
    cx, cy = el['x'] + el['width'] / 2, el['y'] + el['height'] / 2
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    sx = (el['width'] / 2) / abs(dx) if dx else math.inf
    sy = (el['height'] / 2) / abs(dy) if dy else math.inf
    s = min(sx, sy)
    return cx + dx * s, cy + dy * s


for e in src['edges']:
    a, b = node_el.get(e['from']), node_el.get(e['to'])
    if not a or not b:
        print('skip edge', e, file=sys.stderr)
        continue
    acx, acy = a['x'] + a['width'] / 2, a['y'] + a['height'] / 2
    bcx, bcy = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
    x1, y1 = border_point(a, bcx, bcy)
    x2, y2 = border_point(b, acx, acy)
    gap = 6
    L = math.hypot(x2 - x1, y2 - y1) or 1
    ux, uy = (x2 - x1) / L, (y2 - y1) / L
    x1, y1, x2, y2 = x1 + ux * gap, y1 + uy * gap, x2 - ux * gap, y2 - uy * gap
    color = e.get('color', '#495057')
    arr = base('arrow', x1, y1, abs(x2 - x1), abs(y2 - y1), points=[[0, 0], [round(x2 - x1, 1), round(y2 - y1, 1)]],
               lastCommittedPoint=None, startArrowhead='arrow' if e.get('both') else None, endArrowhead='arrow',
               startBinding={'elementId': a['id'], 'focus': 0, 'gap': gap},
               endBinding={'elementId': b['id'], 'focus': 0, 'gap': gap}, elbowed=False,
               strokeColor=color, strokeWidth=2 if not e.get('thick') else 3,
               strokeStyle='dashed' if e.get('dashed') else 'solid', roundness={'type': 2})
    a['boundElements'].append({'id': arr['id'], 'type': 'arrow'})
    b['boundElements'].append({'id': arr['id'], 'type': 'arrow'})
    if e.get('label'):
        label(arr, e['label'], 13, '#343a40')

# ── заметки — столбиком справа ──
if src.get('notes'):
    nx = colx[-1] + colw[-1] + GROUP_GAP
    y = 0
    head = 'Пояснения'
    t = base('text', nx, y, 10, 10, text=head, originalText=head, fontSize=24, fontFamily=FONT, textAlign='left',
             verticalAlign='top', containerId=None, autoResize=True, lineHeight=1.25)
    t['width'], t['height'] = text_size(head, 24)
    y += 50
    for note in src['notes']:
        body = '• ' + note
        box = base('rectangle', nx, y, 520, 10, strokeColor='#adb5bd', backgroundColor='#fff9db', roundness={'type': 3},
                   strokeWidth=1)
        wrapped = []
        for para in body.split('\n'):
            line = ''
            for word in para.split(' '):
                if len(line) + len(word) + 1 > 58:
                    wrapped.append(line)
                    line = '  ' + word
                else:
                    line = (line + ' ' + word).strip() if line else word
            wrapped.append(line)
        txt = '\n'.join(wrapped)
        _, h = text_size(txt, 15)
        box['height'] = h + 24
        label(box, txt, 15)
        box_text = elements[-1]
        box_text['textAlign'] = 'left'
        y += box['height'] + 16

# Порядок: рамки первыми — так Excalidraw рисует их под содержимым.
elements.sort(key=lambda e: 0 if e['type'] == 'frame' else 1)
doc = {'type': 'excalidraw', 'version': 2, 'source': 'cord', 'elements': elements,
       'appState': {'viewBackgroundColor': '#ffffff', 'gridSize': None}, 'files': {}}
json.dump(doc, open(out_path, 'w'), ensure_ascii=False, indent=1)
print(f'{len(elements)} elements → {out_path}', file=sys.stderr)
