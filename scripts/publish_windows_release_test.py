import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PUBLISH = Path(__file__).with_name('publish-windows-release.py')
REPO = 'MikkiMays/ModernStreamingSystem.Windows'

class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifacts = self.root / 'artifacts'
        self.artifacts.mkdir()
        self.destination = self.root / 'published'
        self.metadata = self.root / 'release.json'

    def prepare(self, version='0.4.1', body=b'original installer'):
        tag = 'v' + version
        names = [f'Cord-Setup-{version}-x64.exe', 'Cord-win-x64.zip']
        for name in names:
            (self.artifacts / name).write_bytes(body)
            (self.artifacts / (name + '.sha256')).write_text(hashlib.sha256(body).hexdigest() + '  ' + name)
        assets = []
        for name in names + [name + '.sha256' for name in names]:
            data = (self.artifacts / name).read_bytes()
            assets.append(dict(name=name, size=len(data), digest='sha256:' + hashlib.sha256(data).hexdigest(), browser_download_url=f'https://github.com/{REPO}/releases/download/{tag}/{name}'))
        self.metadata.write_text(json.dumps(dict(tag_name=tag, draft=False, prerelease=False, html_url=f'https://github.com/{REPO}/releases/tag/{tag}', assets=assets)))

    def publish(self, success=True):
        result = subprocess.run([sys.executable, str(PUBLISH), str(self.metadata), str(self.artifacts), '--destination', str(self.destination)], capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)

    def test_verified_publication_and_repeat_preserve_files(self):
        self.prepare(); self.publish(); self.publish()
        manifest = json.loads((self.destination / 'latest.json').read_text())
        self.assertEqual(manifest['repository'], REPO)
        self.assertEqual((self.destination / 'v0.4.1/Cord-Setup-0.4.1-x64.exe').read_bytes(), b'original installer')

    def test_corrupt_download_does_not_publish_latest(self):
        self.prepare()
        (self.artifacts / 'Cord-Setup-0.4.1-x64.exe').write_bytes(b'corrupt')
        self.publish(False)
        self.assertFalse((self.destination / 'latest.json').exists())

    def test_published_version_cannot_change_content(self):
        self.prepare(); self.publish()
        self.prepare(body=b'replacement'); self.publish(False)
        self.assertEqual((self.destination / 'v0.4.1/Cord-Setup-0.4.1-x64.exe').read_bytes(), b'original installer')

    def test_latest_cannot_downgrade(self):
        self.prepare(); self.publish()
        self.prepare('0.4.0'); self.publish(False)
        self.assertEqual(json.loads((self.destination / 'latest.json').read_text())['tag_name'], 'v0.4.1')

    def test_unrelated_repository_is_rejected(self):
        self.prepare()
        self.metadata.write_text(self.metadata.read_text().replace(REPO, 'someone/else'))
        self.publish(False)
        self.assertFalse(self.destination.exists())

if __name__ == '__main__':
    unittest.main()
