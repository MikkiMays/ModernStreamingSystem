#!/usr/bin/env bash
# cargo в контейнере: на машинах Cord Rust не стоит, компилятор — ступень `toolchain` из
# `infra/Dockerfile.insight` (тот же номер, что в `rust-toolchain.toml`).
#
#   rust/cargo.sh check
#   rust/cargo.sh test -p cord-insight keys::
#   DATABASE_URL=postgres://… rust/cargo.sh test        # тестам с базой нужен PostgreSQL на петле
#
# Реестр crates.io и каталог сборки — именованные тома: повторная сборка идёт с места, где остановилась.
# Память и число заданий ограничены: машина разработки общая со стендом (CARGO_JOBS, CARGO_MEMORY).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
image=${CARGO_IMAGE:-cord-insight-toolchain}
if ! docker image inspect "$image" > /dev/null 2>&1; then
  docker build -q -f "$here/../infra/Dockerfile.insight" --target toolchain -t "$image" "$here/.." > /dev/null
fi
exec docker run --rm --network host \
  --memory "${CARGO_MEMORY:-2g}" --cpu-shares 512 \
  -e CARGO_BUILD_JOBS="${CARGO_JOBS:-2}" -e CARGO_TERM_COLOR="${CARGO_TERM_COLOR:-never}" \
  -e CARGO_TARGET_DIR=/target -e DATABASE_URL -e INSIGHT_WRITE_FIXTURES -e RUST_BACKTRACE \
  -v cord-rust-registry:/usr/local/cargo/registry \
  -v cord-rust-target:/target \
  -v "$here/..":/workspace -w /workspace/rust \
  "$image" cargo "$@"
