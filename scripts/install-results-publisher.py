"""Install the per-user retry job after the reviewed results route is ready."""
import argparse
import json
from pathlib import Path
import plistlib
import subprocess
import os
import shutil

ROOT = Path(__file__).resolve().parents[1]
LABEL = 'eu.tsilva.scummbench.results'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true', required=True)
    parser.add_argument('--uploader-command', help='Explicit nonsecret JSON argv for the publication worker')
    args = parser.parse_args()
    config = ROOT / 'local/results-publication.json'
    if config.is_symlink() or config.stat().st_mode & 0o077 or json.loads(config.read_text()).get('enabled') is not True:
        raise ValueError('Reviewed publication configuration required')
    node = shutil.which('node')
    if not node:
        raise ValueError('Node.js unavailable')
    directory = ROOT / '.internal/publication'
    if directory.is_symlink() or (ROOT / '.internal').is_symlink():
        raise ValueError('Linked publication state')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    value = {'Label': LABEL, 'ProgramArguments': [str(Path(node).resolve()), str(ROOT / 'scripts/results-sync.js'), '--once'],
             'WorkingDirectory': str(ROOT), 'StartInterval': 60, 'RunAtLoad': True,
             'ProcessType': 'Standard', 'StandardOutPath': str(directory / 'service.log'),
             'StandardErrorPath': str(directory / 'service.log'),
             'EnvironmentVariables': {'PATH': str(Path(node).parent) + ':/Library/Frameworks/Python.framework/Versions/3.11/bin:/usr/bin:/bin'}}
    if args.uploader_command is not None:
        command = json.loads(args.uploader_command)
        if (len(args.uploader_command.encode()) > 65536 or not isinstance(command, list)
            or not 1 <= len(command) <= 32 or any(not isinstance(item, str)
            or len(item.encode()) > 4096 or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in item)
            for item in command) or not Path(command[0]).is_absolute()):
            raise ValueError('Invalid supplied uploader command')
        value['EnvironmentVariables']['SCUMMBENCH_RESULTS_UPLOADER_COMMAND'] = args.uploader_command
    content = plistlib.dumps(value)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.is_symlink() or target.read_bytes() != content:
            raise ValueError('Existing retry job differs; preserve and review it')
    else:
        target.write_bytes(content); target.chmod(0o600)
    domain = 'gui/' + str(os.getuid())
    state = subprocess.run(['launchctl', 'print', domain + '/' + LABEL], capture_output=True)
    if state.returncode:
        subprocess.run(['launchctl', 'bootstrap', domain, str(target)], check=True, capture_output=True)
    subprocess.run(['launchctl', 'kickstart', domain + '/' + LABEL], check=True, capture_output=True)
    print('Automatic results retry job installed.')


if __name__ == '__main__':
    main()
