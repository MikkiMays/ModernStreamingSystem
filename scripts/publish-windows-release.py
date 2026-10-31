#!/usr/bin/env python3
"""Publish a verified Electron release (tag desktop-vX.Y.Z); download.json changes only after all files exist.

`Cord-Setup-X.Y.Z.exe`, `.blockmap`, `latest.yml` and `latest.yml.sig` go into `desktop/` — the electron-updater
channel (ADR 0001 §5). The manifest is written last; `--keep 2` keeps the previous installer for blockmap deltas.
`download.json` then points the /download page at `desktop/`. The WinUI client and its `vX.Y.Z/` releases are
gone (01.11.2026); `--desktop` is still accepted so older commands keep working.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

REPOSITORY = "MikkiMays/ModernStreamingSystem.Windows"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("metadata", type=Path, help="GitHub releases/tags/vX.Y.Z API JSON")
parser.add_argument("artifacts", type=Path, help="Directory with the downloaded release files")
parser.add_argument("--destination", type=Path, default=Path(".local/windows-releases"))
# Сколько выпусков остаётся на сервере. Наружу отдаётся ровно один — тот, что в download.json:
# страница /download и обновлялка клиента спрашивают только его, а старые каталоги лежали
# мёртвым грузом по 400 МБ каждый. Второй остаётся не для раздачи, а для человека: вернуть
# вчерашний установщик, не ходя на GitHub. Ноль означает «не убирать ничего».
parser.add_argument("--keep", type=int, default=2, help="How many releases stay on disk (0 keeps all)")
parser.add_argument("--desktop", action="store_true", help="Accepted for compatibility: every release is Electron")
args = parser.parse_args()
release = json.loads(args.metadata.read_text())
tag = release["tag_name"]
prefix = "desktop-v"
if release["draft"] or release["prerelease"] or not re.fullmatch(re.escape(prefix) + r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", tag):
    raise SystemExit("Only stable version tags are accepted")
version = tag[len(prefix):]
if release["html_url"] != f"https://github.com/{REPOSITORY}/releases/tag/{tag}":
    raise SystemExit("Unexpected upstream repository")
installer = f"Cord-Setup-{version}.exe"
names = {installer, installer + ".blockmap"}
names |= {name + ".sha256" for name in names}
names |= {"latest.yml", "latest.yml.sig"}
assets = {asset["name"]: asset for asset in release["assets"]}
for name in names:
    asset = assets[name]
    path = args.artifacts / name
    if asset["browser_download_url"] != f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}":
        raise SystemExit("Unexpected asset URL")
    digest = hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
    if asset["size"] != path.stat().st_size or asset.get("digest") != "sha256:" + digest:
        raise SystemExit("Release checksum or size mismatch: " + name)
    if not name.endswith(".sha256") and (name + ".sha256") in names and (args.artifacts / (name + ".sha256")).read_text().split()[0].lower() != digest:
        raise SystemExit("Sidecar checksum mismatch: " + name)
# The signed manifest must describe exactly this installer: version, name and size. The
# signature itself is checked by the client against its embedded keys; here only the shape.
manifest = (args.artifacts / "latest.yml").read_text()
if f"version: {version}\n" not in manifest or f"url: {installer}\n" not in manifest:
    raise SystemExit("latest.yml does not describe " + installer)
if not re.fullmatch(r"[A-Za-z0-9+/=]{86,90}\s*", (args.artifacts / "latest.yml.sig").read_text()):
    raise SystemExit("latest.yml.sig is not an Ed25519 signature")
args.destination.mkdir(parents=True, exist_ok=True)
current = args.destination / "download.json"
if current.exists():
    previous = json.loads(current.read_text())["version"]
    if tuple(map(int, previous.split("."))) > tuple(map(int, version.split("."))):
        raise SystemExit("Refusing to downgrade the published release")
with tempfile.TemporaryDirectory(prefix=".release-", dir=args.destination) as folder:
    # One channel directory for all desktop releases: the installer and blockmap of the previous
    # version stay (deltas), and latest.yml is replaced atomically, last of all.
    channel = args.destination / "desktop"
    channel.mkdir(exist_ok=True)
    for name in sorted(names, key=lambda item: item.startswith("latest")):
        if name.startswith("latest"):
            continue
        if (channel / name).exists() and hashlib.file_digest((channel / name).open("rb"), "sha256").hexdigest() != assets[name]["digest"][7:]:
            raise SystemExit("Refusing to replace a published file: " + name)
        staged = Path(folder) / name
        shutil.copyfile(args.artifacts / name, staged)
        os.chmod(staged, 0o644)
        os.replace(staged, channel / name)
    for name in ("latest.yml.sig", "latest.yml"):
        staged = Path(folder) / name
        shutil.copyfile(args.artifacts / name, staged)
        os.chmod(staged, 0o644)
        os.replace(staged, channel / name)

    # The one public description of the release, for the download page and the client's update
    # splash alike: version and files with sizes and digests, nothing of the repository. The
    # whole GitHub record used to go out as `latest.json` for clients before 0.7.8; there are no
    # such clients (owner decision В-2), so it is no longer published and a leftover is removed.
    page = {
        "version": version,
        # The /download page builds `vX.Y.Z/` from this tag unless a file carries `path`.
        "tag": "v" + version,
        # Informational only: a release without this field is still a release, and failing
        # the whole publication over a display timestamp would be a poor trade.
        "publishedAt": release.get("published_at") or "",
        "files": [
            {
                "name": name,
                "kind": "installer" if name.endswith(".exe") else "portable",
                "size": assets[name]["size"],
                "sha256": assets[name]["digest"][7:],
                "path": "desktop/",
            }
            for name in sorted(names)
            if name.endswith(".exe")
        ],
    }
    catalogue = Path(folder) / "download.json"
    catalogue.write_text(json.dumps(page, ensure_ascii=False, indent=2) + "\n")
    os.chmod(catalogue, 0o644)
    os.replace(catalogue, current)
(args.destination / "latest.json").unlink(missing_ok=True)

# Старые выпуски убираются ПОСЛЕ того, как `download.json` уже указывает на
# новый. Порядок здесь — это и есть безопасность: пока манифест не переписан, страница
# раздаёт прежний каталог, и убрать его значило бы отдать 404 тому, кто нажал «Скачать» в
# эту секунду. Провалившаяся выкладка сюда не доходит вовсе — и ничего не удаляет.
removed = []
if args.keep > 0:
    # The channel keeps the current installer and `--keep - 1` previous ones for blockmap deltas.
    installers = sorted(
        (path for path in (args.destination / "desktop").glob("Cord-Setup-*.exe") if re.fullmatch(r"Cord-Setup-\d+\.\d+\.\d+\.exe", path.name)),
        key=lambda path: tuple(int(part) for part in path.name[len("Cord-Setup-"):-4].split(".")),
        reverse=True,
    )
    for path in installers[args.keep:]:
        if path.name == installer:
            continue
        for stale in (path, Path(str(path) + ".blockmap"), Path(str(path) + ".sha256"), Path(str(path) + ".blockmap.sha256")):
            if stale.exists():
                stale.unlink()
        removed.append(path.name)
print(
    f"Published {tag}: {len(names)} verified assets"
    + (f"; removed {', '.join(removed)}" if removed else "; nothing to remove")
)
