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

    def prepare_desktop(self, version='1.0.0', body=b'electron installer'):
        # Выпуск Electron (E01-B): релиз `desktop-vX.Y.Z`, установщик, blockmap и подписанный latest.yml.
        tag = 'desktop-v' + version
        installer = f'Cord-Setup-{version}.exe'
        files = {installer: body, installer + '.blockmap': b'blockmap'}
        for name, data in files.items():
            (self.artifacts / name).write_bytes(data)
            (self.artifacts / (name + '.sha256')).write_text(hashlib.sha256(data).hexdigest() + '  ' + name)
        (self.artifacts / 'latest.yml').write_text(f'version: {version}\nfiles:\n  - url: {installer}\n    sha512: x\n    size: {len(body)}\npath: {installer}\nsha512: x\n')
        (self.artifacts / 'latest.yml.sig').write_text('A' * 88 + '\n')
        assets = []
        for name in list(files) + [name + '.sha256' for name in files] + ['latest.yml', 'latest.yml.sig']:
            data = (self.artifacts / name).read_bytes()
            assets.append(dict(name=name, size=len(data), digest='sha256:' + hashlib.sha256(data).hexdigest(), browser_download_url=f'https://github.com/{REPO}/releases/download/{tag}/{name}'))
        self.metadata.write_text(json.dumps(dict(tag_name=tag, draft=False, prerelease=False, html_url=f'https://github.com/{REPO}/releases/tag/{tag}', assets=assets)))

    def publish(self, success=True, keep=None, desktop=False):
        command = [sys.executable, str(PUBLISH), str(self.metadata), str(self.artifacts), '--destination', str(self.destination)]
        if keep is not None:
            command += ['--keep', str(keep)]
        if desktop:
            command += ['--desktop']
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)

    def test_verified_publication_and_repeat_preserve_files(self):
        self.prepare(); self.publish(); self.publish()
        text = (self.destination / 'download.json').read_text()
        self.assertEqual(json.loads(text)['version'], '0.4.1')
        # Наружу — только версия и файлы: ни адресов, ни учёта репозитория (T56).
        self.assertNotIn('github', text)
        self.assertFalse((self.destination / 'latest.json').exists())
        self.assertEqual((self.destination / 'v0.4.1/Cord-Setup-0.4.1-x64.exe').read_bytes(), b'original installer')

    def test_corrupt_download_does_not_publish_latest(self):
        self.prepare()
        (self.artifacts / 'Cord-Setup-0.4.1-x64.exe').write_bytes(b'corrupt')
        self.publish(False)
        self.assertFalse((self.destination / 'download.json').exists())

    def test_published_version_cannot_change_content(self):
        self.prepare(); self.publish()
        self.prepare(body=b'replacement'); self.publish(False)
        self.assertEqual((self.destination / 'v0.4.1/Cord-Setup-0.4.1-x64.exe').read_bytes(), b'original installer')

    def test_latest_cannot_downgrade(self):
        self.prepare(); self.publish()
        self.prepare('0.4.0'); self.publish(False)
        self.assertEqual(json.loads((self.destination / 'download.json').read_text())['version'], '0.4.1')

    def test_old_releases_are_dropped_but_the_served_one_stays(self):
        # Отдаётся наружу только последний выпуск, а каждый прежний — это 400 МБ, которые
        # никто никогда не скачает. Один остаётся про запас, дальше каталоги уходят.
        for version in ['0.4.0', '0.4.1', '0.5.0', '0.6.0']:
            self.prepare(version, body=('installer ' + version).encode()); self.publish()
        self.assertEqual(sorted(path.name for path in self.destination.glob('v*')), ['v0.5.0', 'v0.6.0'])
        self.assertEqual(json.loads((self.destination / 'download.json').read_text())['version'], '0.6.0')
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

    def test_the_old_github_record_is_removed(self):
        # До 0.7.8 клиент читал `latest.json` — запись выпуска GitHub целиком. Клиентов старше
        # нет (решение владельца В-2), и публичный файл с учётом репозитория больше не нужен.
        self.destination.mkdir()
        (self.destination / 'latest.json').write_text(json.dumps(dict(tag_name='v0.4.0')))
        self.prepare(); self.publish()
        self.assertFalse((self.destination / 'latest.json').exists())

    def test_unrelated_repository_is_rejected(self):
        self.prepare()
        self.metadata.write_text(self.metadata.read_text().replace(REPO, 'someone/else'))
        self.publish(False)
        self.assertFalse(self.destination.exists())

    def test_desktop_release_goes_into_the_channel_and_keeps_the_previous_installer(self):
        self.prepare_desktop('1.0.0', b'first'); self.publish(desktop=True)
        channel = self.destination / 'desktop'
        self.assertEqual((channel / 'Cord-Setup-1.0.0.exe').read_bytes(), b'first')
        self.assertTrue((channel / 'latest.yml.sig').exists())
        page = json.loads((self.destination / 'download.json').read_text())
        self.assertEqual(page['version'], '1.0.0')
        self.assertEqual(page['tag'], 'v1.0.0')
        self.assertEqual(page['files'], [dict(name='Cord-Setup-1.0.0.exe', kind='installer', size=5, sha256=hashlib.sha256(b'first').hexdigest(), path='desktop/')])
        self.assertNotIn('github', (self.destination / 'download.json').read_text())
        # Следующий выпуск: прежний установщик остаётся для дельт blockmap, третий — убирается.
        self.prepare_desktop('1.0.1', b'second'); self.publish(desktop=True)
        self.prepare_desktop('1.0.2', b'third'); self.publish(desktop=True)
        self.assertFalse((channel / 'Cord-Setup-1.0.0.exe').exists())
        self.assertTrue((channel / 'Cord-Setup-1.0.1.exe').exists())
        self.assertIn('version: 1.0.2', (channel / 'latest.yml').read_text())
        self.assertEqual(json.loads((self.destination / 'download.json').read_text())['version'], '1.0.2')

    def test_desktop_release_refuses_a_manifest_for_another_installer(self):
        self.prepare_desktop('1.0.0')
        (self.artifacts / 'latest.yml').write_text('version: 1.0.1\nfiles:\n  - url: Cord-Setup-1.0.1.exe\n')
        assets = json.loads(self.metadata.read_text())
        for asset in assets['assets']:
            if asset['name'] == 'latest.yml':
                data = (self.artifacts / 'latest.yml').read_bytes()
                asset['size'] = len(data); asset['digest'] = 'sha256:' + hashlib.sha256(data).hexdigest()
        self.metadata.write_text(json.dumps(assets))
        self.publish(success=False, desktop=True)
        self.assertFalse((self.destination / 'download.json').exists())


if __name__ == '__main__':
    unittest.main()
