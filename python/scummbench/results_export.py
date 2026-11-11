"""Public-safe chart projection of an already verified archive.

This module never imports agent code, reads credentials, or infers completion
from an archive's declared status. Missing evidence remains unavailable.
"""
import hashlib
import json
import re
from datetime import datetime, timezone


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def archive_display(stats):
    if stats.get("status") == "in_progress":
        return {"display_unavailable_reason": "in_progress"}
    curve, progress = stats.get("progress_curve"), stats.get("verified_progress")
    available = bool(curve and progress and curve.get("map_revision") == progress.get("map_revision")
                     and re.fullmatch(r"[a-f0-9]{64}", curve.get("map_revision", "")))
    game = stats.get("game_id", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,120}", game):
        return {"display_unavailable_reason": "invalid_evidence"}
    points = [{"actions": point["actions"], "progress": point["percent"]} for point in curve["points"]] if available else []
    won = available and progress.get("won") is True
    if any(point["progress"] == 100 for point in points):
        # A 100% milestone checklist is not a native ending. Without a timed
        # won sample, do not claim that an earlier 100% point finished the game.
        first = next(point for point in curve["points"] if point["percent"] == 100)
        if not won or first["recorded_at"] != progress.get("recorded_at"):
            return {"display_unavailable_reason": "unverified_ending"}
        ending = next(index for index, point in enumerate(points) if point["progress"] == 100)
        points = points[:ending + 1]
    elif won:
        return {"display_unavailable_reason": "unverified_ending"}
    checksum = stats["trajectory"]["sha256"]
    # Legacy archives do not establish frozen game editions, budgets, starting
    # state or tool contracts. Each stays isolated even with a shared map hash.
    version = fingerprint({"archive": checksum, "progress": curve["map_revision"] if available else "Unknown; counts only", "actions": "submitted-records-v1"})
    finished = datetime.fromisoformat(stats["recorded_through"].replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    date = finished[:10]
    result = {
        "source": {"id": "archive-" + checksum, "game": game, "category": "archive"},
        "version": {
            "id": version, "label": "Legacy · " + version[:8], "context": "Archived play · Starting state unknown",
            "identity_sha256": version, "isolated": True,
            "contract": {"game_edition": "Unknown; isolated archive", "start": "Unknown; isolated archive",
                "track": "Assisted" if stats.get("walkthrough_urls") else "Undeclared; isolated archive",
                "progress_revision": curve["map_revision"] if available else "Unknown; counts only", "action_revision": "submitted-records-v1",
                "completion_revision": "native-won-v1", "toolset_revision": "Unknown; isolated archive"},
        },
        "run": {"id": "archive-" + checksum, "label": "Archived run " + checksum[:8], "date": date, "finished_at": finished,
            "actions": stats.get("total_actions", sum(stats["actions"].values())),
            "outcome": "completed" if won else "stopped", "completion_verified": won,
            "recorded_outcome": stats["status"],
            "completion_actions": points[-1]["actions"] if won else None, "points": points,
            "evidence_status": "milestones" if available else "actions_only",
            "agent_version": (stats.get("agent") or {}).get("version"),
            "agent_commit": (stats.get("agent") or {}).get("commit_id")},
    }
    return {"display_result": result}
