#!/bin/bash
# Серия прогонов SFU: размеры встреч, раскладки, худший случай, вебинар, много комнат, только звук.
cd "$(dirname "$0")"
run() { ../../backlog/bin/active-meetings.sh | grep -q "Живых встреч нет" || { echo "встречи идут — стоп"; exit 1; }; python3 sfu_run.py "$@"; sleep 8; }
run g10 --duration 60 --max-participants 100 -- --video-publishers 10 --audio-publishers 10 --subscribers 10 --layout 4x4
run g16 --duration 60 --max-participants 100 -- --video-publishers 16 --audio-publishers 16 --subscribers 16 --layout 5x5
run s10 --duration 60 --max-participants 100 -- --video-publishers 10 --audio-publishers 10 --subscribers 10 --layout speaker
run hq10 --duration 60 --max-participants 100 -- --video-publishers 10 --audio-publishers 10 --subscribers 10 --no-simulcast --video-resolution high
run web50 --duration 60 --max-participants 300 -- --video-publishers 1 --audio-publishers 1 --subscribers 50 --layout speaker
run web100 --duration 75 --warmup 30 --max-participants 300 -- --video-publishers 1 --audio-publishers 1 --subscribers 100 --layout speaker --num-per-second 10
run rooms8 --duration 75 --warmup 25 --rooms 8 --max-participants 50 -- --video-publishers 4 --audio-publishers 4 --subscribers 4 --layout 3x3
run audio40 --duration 60 --rooms 4 --max-participants 50 -- --audio-publishers 10 --subscribers 10
echo DONE
