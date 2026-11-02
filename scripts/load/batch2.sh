#!/bin/bash
# Серия 2: как в Cord сейчас — камера одним слоем (без simulcast), каждый смотрит всех (раскладка 5x5).
cd "$(dirname "$0")"
run() { ../../backlog/bin/active-meetings.sh | grep -q "Живых встреч нет" || { echo "встречи идут — стоп"; exit 1; }; python3 sfu_run.py "$@"; sleep 8; }
run c5 --duration 60 --max-participants 100 -- --video-publishers 5 --audio-publishers 5 --subscribers 5 --layout 5x5 --no-simulcast
run c10 --duration 60 --max-participants 100 -- --video-publishers 10 --audio-publishers 10 --subscribers 10 --layout 5x5 --no-simulcast
run c15 --duration 60 --max-participants 100 -- --video-publishers 15 --audio-publishers 15 --subscribers 15 --layout 5x5 --no-simulcast
run c20 --duration 60 --warmup 20 --max-participants 100 -- --video-publishers 20 --audio-publishers 20 --subscribers 20 --layout 5x5 --no-simulcast
run c6x5 --duration 70 --warmup 25 --rooms 6 --max-participants 50 -- --video-publishers 5 --audio-publishers 5 --subscribers 5 --layout 5x5 --no-simulcast
run web150 --duration 80 --warmup 35 --max-participants 300 -- --video-publishers 1 --audio-publishers 1 --subscribers 150 --layout speaker --no-simulcast --num-per-second 10
python3 music_run.py mus1 1 10 60; sleep 8
python3 music_run.py mus8 8 5 60; sleep 8
python3 music_run.py mus16 16 0 60
echo DONE
