"""Exercise the rollback against real temporary files without touching Docker or the host."""
import importlib.util
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cutover', Path(__file__).with_name('cohost-cutover.py'))
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)


class CutoverTests(unittest.TestCase):
    def test_tls_startup_failure_is_retried_before_success(self):
        with patch.object(cutover.time, 'sleep') as sleep:
            with patch.object(cutover, 'verify_legacy', side_effect=[
                subprocess.CalledProcessError(35, ['curl']), None,
            ]) as check:
                cutover.wait_for_check(check)
        self.assertEqual(check.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_persistent_tls_failure_is_propagated_at_deadline(self):
        failure = subprocess.CalledProcessError(35, ['curl'])
        with patch.object(cutover.time, 'sleep') as sleep:
            with patch.object(cutover, 'verify_legacy', side_effect=failure) as check:
                with self.assertRaises(subprocess.CalledProcessError) as result:
                    cutover.wait_for_check(check, timeout=0)
        self.assertIs(result.exception, failure)
        sleep.assert_not_called()

    def test_failed_edge_restores_exact_legacy_compose_and_probes_legacy(self):
        with tempfile.TemporaryDirectory() as directory:
            compose = Path(directory) / 'compose.yaml'
            original = 'services:\n  caddy:\n    ports:\n      - "80:80"\n' + cutover.OLD_PORT + '\n'
            compose.write_text(original)
            calls = []

            def run(*args, **kwargs):
                calls.append(args)
                if args[-1] == 'edge' and 'up' in args:
                    raise RuntimeError('simulated edge startup failure')

            with patch.object(cutover, 'run', side_effect=run), patch.object(cutover, 'verify_legacy') as verify:
                with self.assertRaisesRegex(RuntimeError, 'simulated edge'):
                    cutover.apply_cutover(compose, original, ['meet.example.test'], Path(directory) / 'backup')
            self.assertEqual(compose.read_text(), original)
            self.assertEqual((Path(directory) / 'backup/compose.yaml').read_text(), original)
            self.assertEqual(verify.call_args_list[-1].args, ())
            self.assertIn(('docker', 'compose', 'stop', 'edge'), calls)

    def test_concurrent_legacy_edit_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            compose = Path(directory) / 'compose.yaml'
            original = cutover.OLD_PORT + '\n'
            compose.write_text('someone else changed this\n')
            with patch.object(cutover, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'changed during preflight'):
                    cutover.apply_cutover(compose, original, [], Path(directory) / 'backup')
            run.assert_not_called()
            self.assertEqual(compose.read_text(), 'someone else changed this\n')

    def test_ambiguous_publication_is_rejected(self):
        for source in ['', cutover.OLD_PORT + '\n' + cutover.OLD_PORT]:
            with self.assertRaises(RuntimeError):
                cutover.rewrite(source)


if __name__ == '__main__':
    unittest.main()
