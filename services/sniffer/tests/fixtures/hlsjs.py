"""
hls.js для страниц-фикстур плеера страниц: из реестра npm, той версии и с той подписью (`integrity`), что у
веба в `web/package-lock.json`. Зовётся при сборке тестового образа: у самих тестов сети нет.
"""

import base64
import hashlib
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "1.6.15"
INTEGRITY = "sha512-E3a5VwgXimGHwpRGV+WxRTKeSp2DW5DI5MWv34ulL3t5UNmyJWCQ1KmLEHbYzcfThfXG8amBL+fCYPneGHC4VA=="
URL = f"https://registry.npmjs.org/hls.js/-/hls.js-{VERSION}.tgz"
FILE = "package/dist/hls.light.min.js"


def main(target: str) -> None:
    with urllib.request.urlopen(URL, timeout=60) as response:
        body = response.read(16 * 1024 * 1024)
    digest = "sha512-" + base64.b64encode(hashlib.sha512(body).digest()).decode()
    if digest != INTEGRITY:
        raise SystemExit(f"hls.js {VERSION}: подпись архива не та, что в web/package-lock.json")
    with tarfile.open(fileobj=io.BytesIO(body)) as archive:
        member = archive.extractfile(FILE)
        if member is None:
            raise SystemExit(f"hls.js {VERSION}: в архиве нет {FILE}")
        script = member.read()
    folder = Path(target)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "hls.light.min.js").write_bytes(script)


if __name__ == "__main__":
    main(sys.argv[1])
