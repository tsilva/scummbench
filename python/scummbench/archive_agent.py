"""Portable agent identity captured by the clean pre-play gate."""
import hashlib
import json
from pathlib import Path
import re

SEMVER = re.compile(r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)')


def validate(identity):
    if not isinstance(identity, dict) or identity.get('name') != 'agentscumm':
        raise ValueError('Invalid AgentSCUMM identity')
    unknown = (identity.get('source') == 'historical_start_unknown' and identity.get('version') is None
               and identity.get('commit_id') is None and identity.get('dirty') is None
               and bool(identity.get('resume_checkpoints')))
    if not unknown and (not isinstance(identity.get('version'), str) or not SEMVER.fullmatch(identity['version'])
            or not isinstance(identity.get('commit_id'), str) or not re.fullmatch('[a-f0-9]{40}', identity['commit_id'])
            or identity.get('dirty') is not False or identity.get('source') != 'clean_play_preflight'):
        raise ValueError('AgentSCUMM identity requires a clean versioned starting commit')
    checkpoints = identity.get('resume_checkpoints', [])
    if not isinstance(checkpoints, list):
        raise ValueError('Invalid agent resume checkpoints')
    for checkpoint in checkpoints:
        validate(checkpoint)
    return identity


def verify(directory, identity):
    if identity is None:
        return
    validate(identity)
    evidence = identity.get('evidence') or {}
    path = Path(directory) / 'agent-provenance.json'
    if evidence.get('path') != path.name or path.is_symlink():
        raise ValueError('Invalid agent provenance path')
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != evidence.get('sha256') or json.loads(data) != {
            key: value for key, value in identity.items() if key != 'evidence'}:
        raise ValueError('Agent provenance checksum or identity mismatch')
