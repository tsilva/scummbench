#!/usr/bin/env python3
"""Dispatch to this checkout's explicitly reviewed W&B Agent Vault launcher."""
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = {'instance': 'https://app.infisical.com',
          'project_id': 'cba79865-b229-4181-909b-0da11a052799',
          'environment': 'prod', 'path': '/wandb', 'variable': 'WANDB_API_KEY'}


def load_route(file):
    if file.stat().st_mode & 0o077:
        raise ValueError('Route metadata must be owner-only.')
    route = json.loads(file.read_text())
    if (set(route) != {'version', 'launcher', 'bundle', 'source'} or type(route['version']) is not int
        or route['version'] != 1 or route['bundle'] != 'local-scummbench-wandb' or route['source'] != SOURCE
        or not isinstance(route['launcher'], str) or not Path(route['launcher']).is_absolute()
        or not os.access(route['launcher'], os.X_OK)):
        raise ValueError('Route metadata does not match the reviewed W&B profile.')
    return route


def main(args):
    if not args:
        sys.exit('Usage: python3 scripts/wandb-agent-vault.py --check | COMMAND [ARG ...]')
    try:
        route = load_route(ROOT / 'local/wandb-agent-vault.json')
    except (OSError, ValueError, TypeError):
        sys.exit('Reviewed W&B route unavailable. Check owner-only local/wandb-agent-vault.json; no credential fallback is permitted.')
    os.execv(route['launcher'], [route['launcher'], *args])


if __name__ == '__main__':
    main(sys.argv[1:])
