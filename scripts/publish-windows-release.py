#!/usr/bin/env python3
"""Publish a verified GitHub release artifact; latest changes only after all files exist."""
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
parser.add_argument("artifacts", type=Path, help="Extracted Cord-win-x64 workflow artifact")
parser.add_argument("--destination", type=Path, default=Path(".local/windows-releases"))
args = parser.parse_args()
release = json.loads(args.metadata.read_text())
tag = release["tag_name"]
if release["draft"] or release["prerelease"] or not re.fullmatch(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", tag):
    raise SystemExit("Only stable version tags are accepted")
version = tag[1:]
if release["html_url"] != f"https://github.com/{REPOSITORY}/releases/tag/{tag}":
    raise SystemExit("Unexpected upstream repository")
names = {f"Cord-Setup-{version}-x64.exe", "Cord-win-x64.zip"}
names |= {name + ".sha256" for name in names}
assets = {asset["name"]: asset for asset in release["assets"]}
for name in names:
    asset = assets[name]
    path = args.artifacts / name
    if asset["browser_download_url"] != f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}":
        raise SystemExit("Unexpected asset URL")
    digest = hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
    if asset["size"] != path.stat().st_size or asset.get("digest") != "sha256:" + digest:
        raise SystemExit("Release checksum or size mismatch: " + name)
    if not name.endswith(".sha256") and (args.artifacts / (name + ".sha256")).read_text().split()[0].lower() != digest:
        raise SystemExit("Sidecar checksum mismatch: " + name)
args.destination.mkdir(parents=True, exist_ok=True)
latest = args.destination / "latest.json"
if latest.exists():
    previous = json.loads(latest.read_text())["tag_name"]
    if tuple(map(int, previous[1:].split("."))) > tuple(map(int, version.split("."))):
        raise SystemExit("Refusing to downgrade latest")
with tempfile.TemporaryDirectory(prefix=".release-", dir=args.destination) as folder:
    stage = Path(folder) / tag
    stage.mkdir()
    for name in names:
        shutil.copyfile(args.artifacts / name, stage / name)
        os.chmod(stage / name, 0o644)
    target = args.destination / tag
    if target.exists():
        for name in names:
            if hashlib.file_digest((target / name).open("rb"), "sha256").hexdigest() != assets[name]["digest"][7:]:
                raise SystemExit("Refusing to replace a published release: " + name)
    else:
        os.rename(stage, target)
    release["repository"] = REPOSITORY
    manifest = Path(folder) / "latest.json"
    manifest.write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n")
    os.chmod(manifest, 0o644)
    os.replace(manifest, latest)
    # What the download page needs, and nothing else. `latest.json` is the whole GitHub release
    # record — the updater reads it because it verifies the upstream URLs — but a page that only
    # has to draw one button should not be handed the repository's bookkeeping.
    page = {
        "version": version,
        "tag": tag,
        "publishedAt": release["published_at"],
        "files": [
            {
                "name": name,
                "kind": "installer" if name.endswith(".exe") else "portable",
                "size": assets[name]["size"],
                "sha256": assets[name]["digest"][7:],
            }
            for name in sorted(names)
            if not name.endswith(".sha256")
        ],
    }
    catalogue = Path(folder) / "download.json"
    catalogue.write_text(json.dumps(page, ensure_ascii=False, indent=2) + "\n")
    os.chmod(catalogue, 0o644)
    os.replace(catalogue, args.destination / "download.json")
print(f"Published {tag}: {len(names)} verified assets; prior releases preserved")
