"""Synthetic route metadata checks; no service credentials or network."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('wandb_route', Path(__file__).resolve().parents[1] / 'scripts/wandb-agent-vault.py')
ROUTE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ROUTE)


class WandbRouteTests(unittest.TestCase):
    def test_source_overrides_and_credential_values_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix='scummbench-route-test-') as directory:
            file = Path(directory) / 'route.json'
            launcher = Path(directory) / 'launcher'
            launcher.write_text('#!/bin/sh\nexit 0\n')
            launcher.chmod(0o700)
            valid = {'version': 1, 'launcher': str(launcher), 'bundle': 'local-scummbench-wandb', 'source': ROUTE.SOURCE}
            file.write_text(json.dumps(valid))
            file.chmod(0o600)
            self.assertEqual(ROUTE.load_route(file)['bundle'], 'local-scummbench-wandb')
            for changed in [
                {**valid, 'source': {**ROUTE.SOURCE, 'path': '/other'}},
                {**valid, 'source': {**ROUTE.SOURCE, 'environment': 'dev'}},
                {**valid, 'bundle': 'local-wandb'},
                {**valid, 'api_key': 'synthetic-not-a-key'},
                {**valid, 'version': True},
            ]:
                with self.subTest(changed=changed):
                    file.write_text(json.dumps(changed))
                    with self.assertRaises(ValueError):
                        ROUTE.load_route(file)

    def test_shared_metadata_permissions_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix='scummbench-route-test-') as directory:
            file = Path(directory) / 'route.json'
            file.write_text('{}')
            file.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'owner-only'):
                ROUTE.load_route(file)


if __name__ == '__main__':
    unittest.main()
