"""Public publication tests use synthetic registrations, never game archives."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from scummbench.public_results import project, publish
from scummbench.results_export import archive_display


class PublicResultsTests(unittest.TestCase):
    def receipt(self, checksum='a' * 64):
        stats = {'status': 'stopped', 'game_id': 'flight-of-the-amazon-queen',
                 'trajectory': {'sha256': checksum}, 'recorded_through': '2026-11-11T10:00:00Z',
                 'action_coverage': 'unavailable', 'total_actions': 0, 'actions': {}}
        return {'results_owner': 'scummbench', 'trajectory_sha256': checksum,
                **archive_display(stats)}

    def test_public_allowlist_keeps_nulls_and_isolated_versions(self):
        first, second = self.receipt(), self.receipt('b' * 64)
        first['archive'] = '/private/archive'
        raw = first['display_result']
        raw['run']['private'] = {'token': 'do-not-publish'}
        raw['version']['contract']['private'] = 'do-not-publish'
        result = project([first, second])
        self.assertNotIn('do-not-publish', json.dumps(result))
        self.assertNotIn('/private', json.dumps(result))
        versions = result['games'][0]['benchmarks']
        self.assertEqual(len(versions), 2)
        self.assertTrue(all(b['isolated'] for b in versions))
        self.assertTrue(all(b['runs'][0]['actions'] is None for b in versions))
        self.assertEqual(result['diagnostics']['discovered'], 2)
        self.assertEqual(result['revision'], project([second, first])['revision'])

    def test_identity_mismatch_and_duplicate_receipt_fail(self):
        receipt = self.receipt()
        with self.assertRaises(ValueError):
            project([receipt, copy.deepcopy(receipt)])
        receipt['display_result']['run']['id'] = 'other'
        with self.assertRaises(ValueError):
            project([receipt])

    def test_publication_is_idempotent_and_rejects_changed_manifest(self):
        with tempfile.TemporaryDirectory(prefix='scummbench-publication-') as name:
            store = Path(name).resolve()
            archive = store / 'runs/archives/synthetic'
            archive.mkdir(parents=True)
            manifest = archive / 'run.json'
            manifest.write_text('{}\n')
            receipts = store / '.internal/archive-registry'
            receipts.mkdir(parents=True)
            (store / 'web').mkdir()
            receipt = self.receipt()
            receipt.update(archive=str(archive), archive_manifest_sha256=hashlib.sha256(manifest.read_bytes()).hexdigest())
            (receipts / ('a' * 64 + '.json')).write_text(json.dumps(receipt))
            result = publish(store)
            target = store / 'web/results.json'
            before = target.read_bytes()
            self.assertEqual(result, publish(store))
            self.assertEqual(before, target.read_bytes())
            self.assertEqual(result['publication']['mode'], 'snapshot')
            manifest.write_text('{"changed":true}')
            with self.assertRaisesRegex(ValueError, 'manifest changed'):
                publish(store)
            self.assertEqual(before, target.read_bytes())

    def test_linked_receipt_directory_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='scummbench-publication-') as name:
            store = Path(name).resolve()
            (store / '.internal').mkdir()
            (store / 'other').mkdir()
            (store / '.internal/archive-registry').symlink_to(store / 'other', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'Linked'):
                publish(store)
