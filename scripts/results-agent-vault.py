"""Launch the fixed results uploader through its dedicated sandboxed broker."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PROFILE = Path.home() / '.config/infisical/scummbench-results/route.json'
SOURCE = {'instance': 'https://app.infisical.com', 'project_id': 'cba79865-b229-4181-909b-0da11a052799',
          'environment': 'prod', 'path': '/scummbench-results', 'variable': 'BLOB_READ_WRITE_TOKEN'}


def load_profile():
    for file in (PROFILE.parent, PROFILE):
        info = file.lstat()
        if file.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Invalid protected publication profile')
    route = json.loads(PROFILE.read_text())
    if (route['source'] != SOURCE or route['bundle'] != 'local-scummbench-results'
            or route['status'] != 'ready' or route['proxy'] != '127.0.0.1:8283'
            or route['placeholder'] != 'scummbench_results_placeholder'):
        raise ValueError('Unreviewed publication profile')
    for key in ('cli', 'node', 'sandbox', 'ca'):
        file = Path(route[key])
        if not file.is_absolute() or file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != route['sha256'][key]:
            raise ValueError('Publication runtime changed')
    for name, checksum in route['code_sha256'].items():
        file = ROOT / name
        if file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != checksum:
            raise ValueError('Publisher changed; trusted route review required')
    return route


def command(route):
    return [route['cli'], 'agent-vault', 'run', '--domain=' + SOURCE['instance'],
            '--project-id=' + route['agent_vault_project'], '--access-bundle=' + route['bundle'],
            '--proxy=' + route['proxy'], '--ttl=5m', '--no-ca-trust', '--no-skills', '--silent', '--telemetry=false',
            '--ca-fingerprint=' + route['ca_fingerprint'], '--', '/usr/bin/env', 'NO_PROXY=', 'no_proxy=',
            'BLOB_READ_WRITE_TOKEN=' + route['placeholder'], 'NODE_EXTRA_CA_CERTS=' + route['ca'],
            '/usr/bin/sandbox-exec', '-D', 'USER_HOME=' + str(Path.home()), '-D', 'REPOSITORY=' + str(ROOT),
            '-D', 'NODE=' + route['node'], '-D', 'CA=' + route['ca'], '-f', route['sandbox'],
            route['node'], str(ROOT / 'scripts/results-upload.js')]


def main():
    route = load_profile()
    result = subprocess.run(command(route), cwd=ROOT, env={'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin'},
                            capture_output=True, timeout=150)
    if result.returncode:
        raise ValueError('Publication unavailable; broker/client output withheld')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Results publication pending; check the reviewed Infisical route.', file=sys.stderr)
        sys.exit(1)
