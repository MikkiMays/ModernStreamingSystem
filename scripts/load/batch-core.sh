#!/bin/bash
# Нагрузка на ядро: чистое теневое ядро перед каждым прогоном.
cd "$(dirname "$0")"
run() { name=$1; shift; ./core-shadow.sh up >/dev/null 2>&1 || { echo "shadow failed"; exit 1; }; sleep 20; python3 cgrun.py "$name" --warmup 15 lt-core,lt-pg,lt-redis -- node corelt.mjs "$@" 2>&1 | grep -v "^joined" ; }
run k1 20 5 10000 120 k1
run k2 10 20 10000 120 k2
run k3 4 45 15000 120 k3
run k4 100 5 0 90 k4
run k5 1000 1 0 60 k5
./core-shadow.sh up >/dev/null 2>&1; sleep 20
python3 cgrun.py b1 --warmup 10 lt-core,lt-pg,lt-redis -- node boardlt.mjs 5 10 33 2000 60 b1 2>&1 | grep -v "^board sockets"
./core-shadow.sh up >/dev/null 2>&1; sleep 20
python3 cgrun.py b2 --warmup 10 lt-core,lt-pg,lt-redis -- node boardlt.mjs 2 20 33 1000 60 b2 2>&1 | grep -v "^board sockets"
echo DONE
