"""Canonical ScummBench registration of verified AgentSCUMM conversation archives."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from .cli import runtime_root
from . import archive_benchmarks as adapter
from .results_export import archive_display


def file_inventory(directory: Path) -> dict:
    """Fingerprint every portable file; never follow linked archive content."""
    files = {}
    for path in sorted(directory.rglob("*")):
        adapter.require(not path.is_symlink(), "Linked archive content")
        if path.is_file():
            with path.open("rb") as stream:
                files[path.relative_to(directory).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
        else:
            adapter.require(path.is_dir(), "Unsupported archive content")
    return files


def retain_archive(archive: Path, store: Path, stats: dict) -> Path:
    """Keep an independently verified, byte-identical copy in the results owner."""
    base = adapter.EXPORT.archive_root(store)
    game = stats["game_id"]
    adapter.require(adapter.re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", game), "Invalid archive game")
    parent = adapter.EXPORT.safe_directory(base / "archives" / game)
    target = parent / archive.name
    before = file_inventory(archive)
    if target.exists():
        adapter.require(not target.is_symlink(), "Linked canonical archive")
        if file_inventory(target) == before:
            return target
        previous = adapter.EXPORT.verify_run(target)
        adapter.require(previous["trajectory"]["sha256"] == stats["trajectory"]["sha256"],
                        "Different archive already occupies the canonical destination")
        # Re-exporting one trajectory can recover previously missing telemetry.
        # Retain the previous archive rather than overwriting its evidence.
        revision = hashlib.sha256((archive / "run.json").read_bytes()).hexdigest()
        target = parent / (archive.name + "-" + revision[:16])
        if target.exists():
            adapter.require(not target.is_symlink() and file_inventory(target) == before,
                            "Different archive already occupies the canonical revision")
            return target
    staging = Path(tempfile.mkdtemp(prefix=".retain-", dir=parent))
    try:
        shutil.copytree(archive, staging, dirs_exist_ok=True)
        adapter.require(file_inventory(staging) == before == file_inventory(archive),
                        "Archive changed while copying")
        adapter.EXPORT.verify_run(staging)
        staging.rename(target)
        return target
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def register(archive: Path, *, source_repo: Path, store: Path,
             title: str | None = None) -> dict:
    archive = Path(os.path.abspath(archive))
    source_repo, store = source_repo.resolve(), store.resolve()
    if not archive.is_relative_to(source_repo / "runs") or any(part.is_symlink() for part in [archive, *archive.parents]):
        raise ValueError("Archive must be an unlinked run in its declared source checkout")
    stats = adapter.EXPORT.verify_run(archive)
    adapter.require(stats["status"] in ("completed", "in_progress", "stopped", "blocked"), "Invalid archived status")
    adapter.require(stats["status"] != "completed" or stats.get("completion_note"), "Missing ending evidence")
    archive = retain_archive(archive, store, stats)
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
            "game_id": stats["game_id"], "status": stats["status"], "official_eligible": False,
            **archive_display(stats)})
        if (store / "web/index.html").is_file():
            from .public_results import publish
            publish(store)
        return {"benchmark_added": added, "results_owner": "scummbench", "benchmark_path": str(target), "receipt": str(receipt)}
    finally:
        lock.unlink()


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--agentscumm", type=Path, help=argparse.SUPPRESS)  # Legacy source-repo spelling only.
    parser.add_argument("--source-repo", type=Path)
    parser.add_argument("--store", type=Path, default=runtime_root())
    parser.add_argument("--game-title")
    args = parser.parse_args(argv)
    try:
        source_repo = args.source_repo or args.agentscumm
        if source_repo is None:
            raise ValueError("--source-repo is required")
        result = register(args.archive, source_repo=source_repo, store=args.store, title=args.game_title)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f"ScummBench registration failed: {error}\n")
    print(json.dumps(result))
