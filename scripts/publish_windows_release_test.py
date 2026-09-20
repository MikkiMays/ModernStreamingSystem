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

    def publish(self, success=True, keep=None):
        command = [sys.executable, str(PUBLISH), str(self.metadata), str(self.artifacts), '--destination', str(self.destination)]
        if keep is not None:
            command += ['--keep', str(keep)]
        result = subprocess.run(command, capture_output=True, text=True)
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

    def test_old_releases_are_dropped_but_the_served_one_stays(self):
        # Отдаётся наружу только последний выпуск, а каждый прежний — это 400 МБ, которые
        # никто никогда не скачает. Один остаётся про запас, дальше каталоги уходят.
        for version in ['0.4.0', '0.4.1', '0.5.0', '0.6.0']:
            self.prepare(version, body=('installer ' + version).encode()); self.publish()
        self.assertEqual(sorted(path.name for path in self.destination.glob('v*')), ['v0.5.0', 'v0.6.0'])
        self.assertEqual(json.loads((self.destination / 'latest.json').read_text())['tag_name'], 'v0.6.0')
        self.assertTrue((self.destination / 'v0.6.0/Cord-Setup-0.6.0-x64.exe').exists())

    def test_keeping_one_release_never_removes_the_one_just_published(self):
        self.prepare('0.4.0'); self.publish(keep=1)
        self.prepare('0.4.1'); self.publish(keep=1)
        self.assertEqual([path.name for path in self.destination.glob('v*')], ['v0.4.1'])
        self.assertTrue((self.destination / 'v0.4.1/Cord-win-x64.zip').exists())

    def test_a_refused_publication_removes_nothing(self):
        self.prepare('0.4.1'); self.publish()
        self.prepare('0.4.0'); self.publish(False, keep=1)
        self.assertTrue((self.destination / 'v0.4.1/Cord-Setup-0.4.1-x64.exe').exists())

    def test_unrelated_repository_is_rejected(self):
        self.prepare()
        self.metadata.write_text(self.metadata.read_text().replace(REPO, 'someone/else'))
        self.publish(False)
        self.assertFalse(self.destination.exists())

if __name__ == '__main__':
    unittest.main()
