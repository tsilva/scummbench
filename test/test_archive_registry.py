"""Synthetic portable archives: registration never imports an agent checkout."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from scummbench.registry import register
from scummbench.archive_verify import verify_run, verify_progress_curve


class ArchiveRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='scummbench-registry-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / '.gitignore').write_text('/runs/\n/.internal/\n')
        self.archive = self.root / 'runs' / 'fixture'
        (self.archive / 'screenshots').mkdir(parents=True)
        trajectory = b'{"type":"session_meta","payload":{"id":"fixture"}}\n'
        (self.archive / 'trajectory.jsonl').write_bytes(trajectory)
        (self.archive / 'screenshots/index.json').write_text('{"screenshots":[]}')
        self.stats = {
            'schema_version': 1, 'status': 'in_progress', 'game_id': 'synthetic-game',
            'trajectory': {'sha256': hashlib.sha256(trajectory).hexdigest(), 'records': 1},
            'source': {'records': 1}, 'screenshots': {'unique_files': 0, 'references_in_trajectory': 0},
            'actions': {}, 'action_sequences': {'count': 0}, 'tokens': {
                'input_tokens': 0, 'cached_input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0},
            'models': ['synthetic'], 'reasoning_levels': [], 'walkthrough_urls': [],
            'recorded_through': '2026-11-11T10:00:00Z', 'wall_clock_seconds': 1,
            'estimated_progress_percent': 0,
        }
        self.write_stats()

    def write_stats(self):
        (self.archive / 'run.json').write_text(json.dumps(self.stats))

    def test_registration_is_portable_and_idempotent(self):
        result = register(self.archive, source_repo=self.root, store=self.root)
        self.assertTrue(result['benchmark_added'])
        self.assertEqual(result['results_owner'], 'scummbench')
        text = (self.root / 'BENCHMARKS.md').read_text()
        self.assertIn('synthetic-game', text)
        self.assertFalse(register(self.archive, source_repo=self.root, store=self.root)['benchmark_added'])
        self.assertEqual((self.root / 'BENCHMARKS.md').read_text(), text)

    def test_corrupt_trajectory_and_unproven_completion_are_rejected(self):
        trajectory = (self.archive / 'trajectory.jsonl').read_bytes()
        (self.archive / 'trajectory.jsonl').write_text('{}\n')
        with self.assertRaisesRegex(ValueError, 'Trajectory checksum mismatch'):
            verify_run(self.archive)
        (self.archive / 'trajectory.jsonl').write_bytes(trajectory)
        self.stats['status'] = 'completed'
        self.stats['estimated_progress_percent'] = 100
        self.write_stats()
        with self.assertRaisesRegex(ValueError, 'Missing ending evidence'):
            register(self.archive, source_repo=self.root, store=self.root)

    def test_progress_and_action_counts_remain_independently_verified(self):
        stats = copy.deepcopy(self.stats)
        stats.update(started_at='2026-11-11T09:00:00Z', total_action_sequences=1,
            timed_action_sequences=[{'submitted_at': '2026-11-11T09:01:00Z', 'types': ['click']}],
            actions={'click': 1}, action_sequences={'count': 1, 'min': 1, 'max': 1, 'mean': 1})
        # Use the format's exact sequence summary rather than duplicating it.
        from scummbench.archive_verify import sequence_stats
        stats['action_sequences'] = sequence_stats([1])
        verify_progress_curve(stats)
        stats['timed_action_sequences'][0]['types'].append('key')
        with self.assertRaisesRegex(ValueError, 'totals'):
            verify_progress_curve(stats)


if __name__ == '__main__':
    unittest.main()
