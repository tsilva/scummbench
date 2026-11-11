"""Synthetic archive chart projections; no agent checkout or game data."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from scummbench.results_export import archive_display


class ResultsExportTests(unittest.TestCase):
    def setUp(self):
        self.stats = {
            'status': 'completed', 'game_id': 'flight-of-the-amazon-queen',
            'trajectory': {'sha256': 'a' * 64}, 'recorded_through': '2026-11-11T10:00:06Z',
            'actions': {'click': 3}, 'total_actions': 3,
            'progress_curve': {'map_revision': 'b' * 64, 'points': [
                {'actions': 0, 'percent': 0, 'recorded_at': '2026-11-11T10:00:00Z'},
                {'actions': 2, 'percent': 100, 'recorded_at': '2026-11-11T10:00:04Z'},
            ]},
            'verified_progress': {'map_revision': 'b' * 64, 'won': True, 'recorded_at': '2026-11-11T10:00:04Z'},
            'private': '/private/transcript/path', 'completion_note': 'private narrative',
        }

    def test_native_completion_uses_the_ending_point_not_later_actions(self):
        result = archive_display(self.stats)['display_result']
        self.assertEqual(result['run']['completion_actions'], 2)
        self.assertEqual(result['run']['actions'], 3)
        self.assertNotIn('private', str(result))
        self.assertTrue(result['version']['isolated'])

    def test_declared_completion_does_not_replace_missing_native_ending(self):
        for change in (lambda s: s['verified_progress'].update(won=False),
                       lambda s: s['verified_progress'].update(recorded_at='2026-11-11T10:00:05Z')):
            stats = copy.deepcopy(self.stats)
            change(stats)
            self.assertEqual(archive_display(stats)['display_unavailable_reason'], 'unverified_ending')

    def test_unfinished_and_unversioned_archives_remain_separate(self):
        stats = copy.deepcopy(self.stats)
        stats['status'] = 'stopped'
        stats['progress_curve']['points'].pop()
        stats['verified_progress']['won'] = False
        first = archive_display(stats)['display_result']
        stats['trajectory']['sha256'] = 'c' * 64
        second = archive_display(stats)['display_result']
        self.assertNotEqual(first['version']['id'], second['version']['id'])
        self.assertIsNone(first['run']['completion_actions'])
        stats['status'] = 'in_progress'
        self.assertEqual(archive_display(stats)['display_unavailable_reason'], 'in_progress')

    def test_counts_only_archives_keep_verified_totals_without_inventing_progress(self):
        stats = copy.deepcopy(self.stats)
        del stats['progress_curve']
        del stats['verified_progress']
        result = archive_display(stats)['display_result']['run']
        self.assertEqual(result['actions'], 3)
        self.assertEqual(result['points'], [])
        self.assertEqual(result['evidence_status'], 'actions_only')
        self.assertFalse(result['completion_verified'])
        self.assertIsNone(result['completion_actions'])
        self.assertEqual(result['recorded_outcome'], 'completed')


if __name__ == '__main__':
    unittest.main()
