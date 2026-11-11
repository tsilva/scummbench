"""Resolve the editable checkout on every invocation and replace Python with Node."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys


def runtime_root() -> Path:
    """Prefer live source under an editable install; support bundled wheels too."""
    module = Path(__file__).resolve()
    checkout = module.parents[2]
    bundled = module.parent / "_runtime"
    for candidate in (checkout, bundled):
        if (candidate / "src" / "cli.js").is_file() and (candidate / "package.json").is_file():
            return candidate
    raise RuntimeError("ScummBench runtime missing; reinstall from the checkout with uv tool install --editable .")


def main() -> None:
    node = shutil.which("node")
    if node is None:
        print("ScummBench requires Node.js 22+ on PATH.", file=sys.stderr)
        raise SystemExit(2)
    try:
        version = subprocess.run([node, "--version"], check=True, capture_output=True, text=True)
        if int(version.stdout.strip().removeprefix("v").split(".")[0]) < 22:
            raise ValueError("Unsupported Node.js version")
        entrypoint = runtime_root() / "src" / "cli.js"
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError):
        print("ScummBench requires Node.js 22+ and an available runtime. Reinstall with uv tool install --editable /path/to/scummbench.", file=sys.stderr)
        raise SystemExit(2) from None
    # No cwd change, argument interpolation, or subprocess intermediary: Node
    # receives arguments and signals directly, with the original environment.
    os.execv(node, [node, str(entrypoint), *sys.argv[1:]])
