"""Canonical ScummBench registration of verified AgentSCUMM conversation archives."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from .cli import runtime_root


def register(archive: Path, *, agentscumm: Path, source_repo: Path, store: Path,
             title: str | None = None) -> dict:
    archive = Path(os.path.abspath(archive))
    source_repo, store, agentscumm = source_repo.resolve(), store.resolve(), agentscumm.resolve()
    if not archive.is_relative_to(source_repo / "runs") or any(part.is_symlink() for part in [archive, *archive.parents]):
        raise ValueError("Archive must be an unlinked run in its declared source checkout")
    # Reuse the source format's maintained verifier and rendering adapter. Only
    # ScummBench owns the registry, lock, receipts, and destination document.
    spec = importlib.util.spec_from_file_location("scummbench_agentscumm_adapter", agentscumm / "scripts/finalize-run.py")
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    stats = adapter.EXPORT.verify_run(archive)
    adapter.require(stats["status"] in ("completed", "in_progress", "stopped", "blocked"), "Invalid archived status")
    adapter.require(stats["status"] != "completed" or stats.get("completion_note"), "Missing ending evidence")
    directory = adapter.private_directory(store, store / ".internal/archive-registry")
    target = store / "BENCHMARKS.md"
    adapter.require(not target.is_symlink(), "Linked benchmark document")
    lock = directory / "update.lock"
    deadline = time.monotonic() + 10
    while True:
        try:
            descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(descriptor)
            break
        except FileExistsError:
            adapter.require(time.monotonic() < deadline, "ScummBench registry lock is busy")
            time.sleep(0.1)
    try:
        before = target.read_bytes() if target.exists() else None
        text = before.decode() if before is not None else (
            "# Benchmarks\n\nDevelopment playthrough records, including assisted and unfinished runs. "
            "These are not controlled success-rate estimates.\n\n" + adapter.BENCHMARK_NOTES)
        updated, added = adapter.update_benchmark(text, stats, title)
        adapter.require((target.read_bytes() if target.exists() else None) == before, "Concurrent benchmark edit; retry")
        if updated.encode() != before:
            descriptor, scratch = tempfile.mkstemp(prefix=".registry-", dir=directory)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    stream.write(updated)
                os.replace(scratch, target)
            finally:
                if Path(scratch).exists():
                    Path(scratch).unlink()
        checksum = stats["trajectory"]["sha256"]
        receipt = directory / f"{checksum}.json"
        adapter.atomic_json(receipt, {"schema_version": 1, "results_owner": "scummbench", "archive": str(archive),
            "trajectory_sha256": checksum, "archive_manifest_sha256": hashlib.sha256((archive / "run.json").read_bytes()).hexdigest(),
            "game_id": stats["game_id"], "status": stats["status"], "official_eligible": False})
        return {"benchmark_added": added, "results_owner": "scummbench", "benchmark_path": str(target), "receipt": str(receipt)}
    finally:
        lock.unlink()


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--agentscumm", type=Path, required=True)
    parser.add_argument("--source-repo", type=Path)
    parser.add_argument("--store", type=Path, default=runtime_root())
    parser.add_argument("--game-title")
    args = parser.parse_args(argv)
    try:
        result = register(args.archive, agentscumm=args.agentscumm,
                          source_repo=args.source_repo or args.agentscumm, store=args.store, title=args.game_title)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f"ScummBench registration failed: {error}\n")
    print(json.dumps(result))
