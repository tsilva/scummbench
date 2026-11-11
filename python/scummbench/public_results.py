"""Publish only verified registration projections, never private run artifacts."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

HASH = re.compile(r'[a-f0-9]{64}')
CONTRACT = ('game_edition', 'start', 'track', 'progress_revision', 'action_revision',
            'completion_revision', 'toolset_revision', 'scummbench_revision', 'mechanics_revision', 'runtime_revision')
RUN = ('id', 'label', 'date', 'finished_at', 'actions', 'outcome', 'completion_verified',
       'completion_actions', 'recorded_outcome', 'evidence_status', 'agent_version', 'agent_commit',
       'progress_percent', 'missing_data', 'screenshot_status')
TITLES = {'flight-of-the-amazon-queen': 'Flight of the Amazon Queen', 'beneath-a-steel-sky': 'Beneath a Steel Sky',
          'elvira-ii-the-jaws-of-cerberus': 'Elvira II: The Jaws of Cerberus',
          'elvira-mistress-of-the-dark': 'Elvira: Mistress of the Dark',
          'indiana-jones-and-the-last-crusade': 'Indiana Jones and the Last Crusade'}


def project(receipts):
    games, seen = {}, set()
    for receipt in receipts:
        raw = receipt.get('display_result')
        if not raw:
            continue
        checksum = receipt.get('trajectory_sha256', '')
        if receipt.get('results_owner') != 'scummbench' or not HASH.fullmatch(checksum):
            raise ValueError('Invalid publication receipt')
        if raw.get('source', {}).get('id') != 'archive-' + checksum or raw.get('run', {}).get('id') != 'archive-' + checksum:
            raise ValueError('Archive projection identity mismatch')
        if checksum in seen:
            raise ValueError('Duplicate publication identity')
        seen.add(checksum)
        game_id = raw['source']['game']
        if not re.fullmatch('[a-z0-9]+(?:-[a-z0-9]+)*', game_id):
            raise ValueError('Invalid public game identity')
        game = games.setdefault(game_id, {'id': game_id, 'label': TITLES.get(game_id, game_id.replace('-', ' ').title()), 'benchmarks': []})
        version = raw['version']
        if not HASH.fullmatch(version.get('id', '')):
            raise ValueError('Invalid public benchmark identity')
        benchmark = next((b for b in game['benchmarks'] if b['id'] == version['id']), None)
        if benchmark is None:
            benchmark = {key: version[key] for key in ('id', 'label', 'context', 'isolated') if key in version}
            benchmark['contract'] = {key: version['contract'][key] for key in CONTRACT if key in version['contract']}
            benchmark['runs'] = []
            game['benchmarks'].append(benchmark)
        run = {key: raw['run'][key] for key in RUN if key in raw['run']}
        run['points'] = [{key: point[key] for key in ('actions', 'progress')} for point in raw['run']['points']]
        benchmark['runs'].append(run)
    result = {'schema_version': 1, 'games': sorted(games.values(), key=lambda g: g['label'])}
    for game in result['games']:
        for benchmark in game['benchmarks']:
            benchmark['runs'].sort(key=lambda r: (r.get('finished_at', r['date']), r['id']), reverse=True)
        game['benchmarks'].sort(key=lambda b: (b['runs'][0].get('finished_at', b['runs'][0]['date']), b['id']), reverse=True)
    runs = [r for g in result['games'] for b in g['benchmarks'] for r in b['runs']]
    result['diagnostics'] = {'discovered': len(runs), 'plotted': sum(bool(r['points']) for r in runs),
                             'counts_only': sum(not r['points'] for r in runs), 'unavailable': {}}
    result['revision'] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return result


def publish(store):
    store = Path(store).resolve()
    directory = store / '.internal/archive-registry'
    if any(p.is_symlink() for p in (directory, directory.parent, store / 'web')):
        raise ValueError('Linked publication directory')
    receipts = []
    for path in sorted(directory.glob('*.json')):
        if not HASH.fullmatch(path.stem):
            continue
        if path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('Invalid publication receipt file')
        receipt = json.loads(path.read_text())
        archive = Path(receipt['archive'])
        if (not archive.is_relative_to(store / 'runs/archives') or
                any(p.is_symlink() for p in (archive, *archive.parents))):
            raise ValueError('Publication requires a canonical local archive')
        manifest = archive / 'run.json'
        if manifest.is_symlink() or hashlib.sha256(manifest.read_bytes()).hexdigest() != receipt['archive_manifest_sha256']:
            raise ValueError('Registered manifest changed; re-register before publishing')
        receipts.append(receipt)
    result = project(receipts)
    target = store / 'web/results.json'
    if target.is_symlink():
        raise ValueError('Linked public results file')
    if target.exists():
        existing = json.loads(target.read_text())
        if existing.get('revision') == result['revision'] and existing.get('publication', {}).get('mode') == 'snapshot':
            return existing
    result['publication'] = {'mode': 'snapshot', 'generated_at': datetime.now(timezone.utc).isoformat()}
    scratch_dir = store / '.internal/public-export'
    if scratch_dir.is_symlink():
        raise ValueError('Linked publication scratch directory')
    scratch_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix='results-', dir=scratch_dir)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(json.dumps(result, indent=2) + '\n')
        os.replace(name, target)
    finally:
        if Path(name).exists():
            Path(name).unlink()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    result = publish(args.store)
    print(json.dumps({'records': result['diagnostics']['discovered'], 'revision': result['revision']}))


if __name__ == '__main__':
    main()
