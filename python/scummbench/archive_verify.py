"""Portable verification of the versioned conversation archive format.

Migrated from AgentSCUMM's exporter; verification never loads an agent checkout.
"""
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
from . import archive_usage as USAGE
from . import archive_agent as AGENT
from . import archive_context as CONTEXT
from . import archive_pricing as PRICING

MIMES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}

DATA_URL = re.compile(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.*)$", re.DOTALL)

TRUNCATED = re.compile(r"^(.*?)…([0-9]+) chars truncated…(.*?)$", re.DOTALL)

def require(condition, message):
    if not condition:
        raise ValueError(message)

def validate_progress(value):
    require(value is None or type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 100,
            "Estimated progress must be a finite percentage between 0 and 100")

def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def safe_directory(path):
    """Reject linked ancestors instead of following a caller's archive path."""
    path = Path(os.path.abspath(path))
    for part in [*reversed(path.parents), path]:
        require(not part.is_symlink(), f"Linked archive directory: {part}")
        require(not part.exists() or part.is_dir(), f"Not a directory: {part}")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path

def archive_root(repo):
    repo = Path(repo).resolve()
    def git(*args):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True,
                                       stderr=subprocess.DEVNULL).strip()
    require(Path(git("rev-parse", "--show-toplevel")).resolve() == repo,
            "Archive root must be the owning Git checkout")
    require("/runs/" in (repo / ".gitignore").read_text().splitlines(),
            "Root .gitignore must contain /runs/")
    require(not git("ls-files", "--", "runs"), "Run archives must not contain tracked files")
    directory = safe_directory(repo / "runs")
    require(git("check-ignore", "runs/export-check/run.json"), "runs/ must be Git-ignored")
    return directory

def progress_curve(samples, sequences):
    """Count all submitted steps in a batch when its request was issued."""
    if not samples or any(when is None for when, _ in sequences):
        return None
    revisions = {sample.get("map_revision") for sample in samples}
    if len(revisions) != 1 or None in revisions:
        return None
    series = sorted((USAGE.timestamp(when), len(steps)) for when, steps in sequences)
    points, highest, index, actions = [], -1, 0, 0
    for sample in sorted(samples, key=lambda item: USAGE.timestamp(item["recorded_at"])):
        percent = sample["percent"]
        if percent <= highest:
            continue
        when = USAGE.timestamp(sample["recorded_at"])
        while index < len(series) and series[index][0] <= when:
            actions += series[index][1]
            index += 1
        points.append({"percent": percent, "recorded_at": sample["recorded_at"],
                       "actions": actions, "action_sequences": index})
        highest = percent
    return {"map_revision": revisions.pop(), "points": points}

def verify_progress_curve(stats):
    sequences = stats.get("timed_action_sequences")
    if sequences is not None:
        actions = Counter()
        submitted = USAGE.timestamp(stats["started_at"])
        end = USAGE.timestamp(stats["recorded_through"])
        for sequence in sequences:
            when = USAGE.timestamp(sequence["submitted_at"])
            require(submitted <= when <= end, "Invalid action sequence timestamp")
            submitted = when
            actions.update(sequence["types"])
        require(len(sequences) == stats["total_action_sequences"] and actions == stats["actions"]
                and sequence_stats([len(sequence["types"]) for sequence in sequences]) == stats["action_sequences"],
                "Timed action sequences do not match archive totals")
    curve = stats.get("progress_curve")
    if curve is None:
        return
    require(re.fullmatch(r"[a-f0-9]{64}", curve["map_revision"]) and curve["points"],
            "Invalid progress curve map revision or empty series")
    require(sequences is not None, "Progress curve requires timed action sequences")
    reconstructed = progress_curve(
        [{**point, "map_revision": curve["map_revision"]} for point in curve["points"]],
        [(sequence["submitted_at"], sequence["types"]) for sequence in sequences])
    require(curve == reconstructed and all(type(point["percent"]) is int and 0 <= point["percent"] <= 100
            and USAGE.timestamp(stats["started_at"]) <= USAGE.timestamp(point["recorded_at"])
            <= USAGE.timestamp(stats["recorded_through"]) for point in curve["points"]),
            "Invalid progress curve points")

def verify_run_progress(stats):
    progress = stats.get("verified_progress")
    if progress is None:
        return
    require(isinstance(progress, dict) and progress.get("state") == "tracked"
            and progress.get("game") == stats["game_id"]
            and progress.get("session_id") in stats.get("sessions", []), "Invalid verified progress identity")
    if "map_revision" in progress:
        revision = progress["map_revision"]
        require(isinstance(revision, str) and re.fullmatch(r"[a-f0-9]{64}", revision),
                "Invalid verified progress map revision")
    when = USAGE.timestamp(progress["recorded_at"])
    require(USAGE.timestamp(stats["started_at"]) <= when <= USAGE.timestamp(stats["recorded_through"]),
            "Verified progress is outside the archive cutoff")
    total, completed, reached = (progress.get(key) for key in ("total", "completed", "reached"))
    won = progress.get("won", False)
    require(type(total) is int and type(completed) is int and 0 <= completed <= total <= 100 and total > 0
            and type(won) is bool and (not won or completed > 0)
            and type(progress.get("percent")) is int
            and progress["percent"] == (100 if won else math.floor(completed * 100 / total + 0.5))
            and isinstance(reached, list) and len(reached) == completed
            and all(isinstance(item, str) and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", item) for item in reached)
            and len(set(reached)) == completed, "Invalid verified milestone count")
    label = progress.get("latest_milestone")
    require(label is None if completed == 0 else isinstance(label, str) and 0 < len(label.strip()) <= 200,
            "Invalid verified milestone label")

def sequence_stats(lengths):
    return {"count": len(lengths),
            "min_length": min(lengths) if lengths else None,
            "max_length": max(lengths) if lengths else None,
            "mean_length": statistics.fmean(lengths) if lengths else None,
            "std_length": statistics.pstdev(lengths) if lengths else None,
            "median_length": statistics.median(lengths) if lengths else None,
            "std_type": "population"}

def records(path):
    with path.open("rb") as stream:
        for number, line in enumerate(stream, 1):
            try:
                yield number, json.loads(line)
            except (ValueError, UnicodeDecodeError):
                require(not line.endswith(b"\n") and not stream.read(1),
                        f"Malformed rollout JSON at line {number}")

def verify_run(directory):
    directory = Path(directory)
    require(not directory.is_symlink(), "Linked run directory")
    metadata = directory / "run.json"
    if not metadata.exists() and not metadata.is_symlink():
        metadata = directory / "stats.json"
    require(not metadata.is_symlink(), "Linked run metadata")
    stats = json.loads(metadata.read_text())
    require(stats.get("schema_version") in (1, 2, 3), "Unsupported run metadata schema")
    if stats["schema_version"] >= 2:
        require("agent_context" in stats and "skills" in stats, "Missing version 2 run metadata")
    if stats["schema_version"] >= 3:
        require("api_cost" in stats, "Missing version 3 pricing metadata")
    if "estimated_progress_percent" in stats:
        validate_progress(stats["estimated_progress_percent"])
        require(stats["status"] != "completed" or stats["estimated_progress_percent"] in (None, 100),
                "Completed runs require 100 percent progress")
    verify_run_progress(stats)
    verify_progress_curve(stats)
    AGENT.verify(directory, stats.get("agent"))
    if "total_actions" in stats or "total_action_sequences" in stats:
        for key, expected in (("total_actions", sum(stats["actions"].values())),
                              ("total_action_sequences", stats["action_sequences"]["count"])):
            require(type(stats.get(key)) is int and stats[key] >= 0 and stats[key] == expected,
                    f"{key} count mismatch")
    if "local_mcp_action_sequences" in stats:
        local_count = stats["local_mcp_action_sequences"]
        require(type(local_count) is int and 0 < local_count <= stats.get("total_action_sequences", 0),
                "Invalid local MCP action sequence count")
    trajectory = directory / "trajectory.jsonl"
    require(not trajectory.is_symlink(), "Linked trajectory")
    require(hashlib.sha256(trajectory.read_bytes()).hexdigest() == stats["trajectory"]["sha256"],
            "Trajectory checksum mismatch")
    index = json.loads((directory / "screenshots/index.json").read_text())
    images = {entry["id"]: entry for entry in index["screenshots"]}
    require(len(images) == len(index["screenshots"]) == stats["screenshots"]["unique_files"],
            "Screenshot count/ID mismatch")
    for identity, entry in images.items():
        require(re.fullmatch(r"screenshot-[0-9a-f]{64}", identity), "Invalid screenshot ID")
        require(entry["path"] == f"screenshots/{identity}.{MIMES[entry['mime_type']]}",
                "Invalid screenshot path")
        path = directory / entry["path"]
        require(not path.is_symlink() and not path.parent.is_symlink(), "Linked screenshot")
        data = path.read_bytes()
        require(len(data) == entry["bytes"] and hashlib.sha256(data).hexdigest() == entry["sha256"] == identity[11:],
                "Screenshot checksum mismatch")
    refs = Counter()
    unforwarded_fragments = 0
    def walk(value):
        nonlocal unforwarded_fragments
        if isinstance(value, dict):
            gap = value.get("unavailable_image")
            if isinstance(gap, dict) and gap.get("scope") == "unforwarded_mcp_result":
                fragment = gap.get("recorded_data")
                require(isinstance(fragment, str) and TRUNCATED.fullmatch(fragment),
                        "Missing unforwarded screenshot fragment")
                unforwarded_fragments += 1
            if {"id", "path", "sha256"} <= value.keys() and str(value["id"]).startswith("screenshot-"):
                require(value["id"] in images, "Missing screenshot reference")
                entry = images[value["id"]]
                require(value["path"] == entry["path"] and value["sha256"] == entry["sha256"],
                        "Screenshot reference mismatch")
                refs[value["id"]] += 1
            require(not (value.get("type") == "image" and "data" in value), "Embedded image remains")
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
        elif isinstance(value, str):
            require(not DATA_URL.fullmatch(value), "Embedded image data URL remains")
            if value.lstrip().startswith(("{", "[")):
                try:
                    parsed = json.loads(value)
                except ValueError:
                    return
                walk(parsed)
    count = 0
    for _, record in records(trajectory):
        count += 1
        walk(record)
    require(count == stats["trajectory"]["records"] == stats["source"]["records"], "Record count mismatch")
    require(sum(refs.values()) == stats["screenshots"]["references_in_trajectory"], "Screenshot reference count mismatch")
    require(all(refs[key] == entry["references"] for key, entry in images.items()), "Unreferenced screenshot or wrong reference count")
    unresolved = stats["screenshots"].get("unresolved", [])
    require(unforwarded_fragments == sum(gap.get("scope") == "unforwarded_mcp_result" for gap in unresolved),
            "Unforwarded screenshot fragment count mismatch")
    require(stats["status"] != "completed" or len(unresolved) == unforwarded_fragments,
            "Completed runs contain unavailable image references")
    if "skills" in stats:
        verify_skills(directory, stats["skills"])
    if "agent_context" in stats:
        CONTEXT.verify(directory, stats["agent_context"])
    if "api_cost" in stats:
        measured = USAGE.snapshot(trajectory, stats["thread_id"])
        require(all(stats["tokens"].get(key) == value for key, value in measured["totals"].items())
                and stats["tokens"]["by_model_and_effort"] == measured["groups"]
                and stats["tokens"]["request_count"] == len(measured["requests"])
                and stats["tokens"]["usage_as_of"] == measured["usage_as_of"],
                "Archived token usage does not match trajectory")
        cost = stats["api_cost"]
        require(cost.get("provider") == measured["provider"] and cost.get("usage_as_of") == measured["usage_as_of"],
                "Pricing provider or usage cutoff mismatch")
        if cost.get("status") == "priced":
            require(cost == PRICING.calculate(USAGE, measured, cost["rates"]),
                    "Archived API price does not match telemetry and rates")
        else:
            require(cost.get("status") == "unavailable" and cost.get("total_api_price_usd") is None
                    and isinstance(cost.get("reason"), str) and cost["reason"],
                    "Invalid unavailable pricing metadata")
    return stats

def verify_skills(directory, summary):
    require(summary["index"] == "skills/index.json", "Invalid skill index path")
    root = directory / "skills"
    require(not root.is_symlink(), "Linked skills directory")
    index_path = root / "index.json"
    require(not index_path.is_symlink(), "Linked skill index")
    data = index_path.read_bytes()
    require(hashlib.sha256(data).hexdigest() == summary["sha256"], "Skill index checksum mismatch")
    index = json.loads(data)
    require(index.get("schema_version") == 1, "Unsupported skill index schema")
    require(index["unresolved"] == summary["unresolved"], "Skill coverage mismatch")
    require(index["provenance"] == summary["provenance"] == "export_time_local_snapshot"
            and index["historical_version_verified"] is summary["historical_version_verified"] is False,
            "Skill provenance mismatch")
    identities, file_count, reference_count = set(), 0, len([r for r in index["unresolved"] if "kind" in r])
    for entry in index["skills"]:
        identity = entry["id"]
        require(re.fullmatch(r"skill-[0-9a-f]{64}", identity) and identity not in identities, "Invalid or duplicate skill ID")
        identities.add(identity)
        require(entry["path"] == f"skills/{identity}", "Invalid skill bundle path")
        require(identity == "skill-" + hashlib.sha256(dump(entry["files"]).encode()).hexdigest(), "Skill manifest checksum mismatch")
        bundle = root / identity
        require(bundle.is_dir() and not bundle.is_symlink(), "Missing or linked skill bundle")
        expected = set()
        for item in entry["files"]:
            relative = item["path"]
            parts = relative.split("/")
            require(relative and not any(part in ("", ".", "..") for part in parts) and "\\" not in relative,
                    "Invalid skill file path")
            require(relative not in expected, "Duplicate skill file")
            expected.add(relative)
            path = bundle
            for part in parts:
                path = path / part
                require(not path.is_symlink(), "Linked skill file or directory")
            require(path.is_file(), "Missing skill file")
            data = path.read_bytes()
            require(len(data) == item["bytes"] and hashlib.sha256(data).hexdigest() == item["sha256"],
                    "Skill file checksum mismatch")
            require(type(item["executable"]) is bool, "Invalid skill executable flag")
        require("SKILL.md" in expected, "Missing skill entrypoint")
        actual = set()
        for path in bundle.rglob("*"):
            require(not path.is_symlink(), "Linked skill file or directory")
            if path.is_file():
                actual.add(path.relative_to(bundle).as_posix())
            else:
                require(path.is_dir(), "Special file in skill bundle")
        require(actual == expected, "Unexpected or missing skill files")
        file_count += len(expected)
        reference_count += len(entry["references"])
    require(len(identities) == summary["bundles"] and file_count == summary["files"]
            and reference_count == summary["references"], "Skill counts mismatch")
    require({path.name for path in root.iterdir()} == identities | {"index.json"}, "Unexpected skill bundles")
