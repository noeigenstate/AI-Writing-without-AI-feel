#!/usr/bin/env python3
"""Validate an evidence-article-pipeline run manifest."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any


SOURCE_TYPES = {"primary", "official", "paper", "media", "commentary"}
CONFIDENCE_LEVELS = {"confirmed", "probable", "disputed", "unverified"}
MEDIA_ORIGINS = {"source", "licensed", "generated"}
TONE_RESULTS = {"passed", "not_applicable", "not_run", "failed"}
REQUIRED_ARTIFACTS = {
    "research_md",
    "clue_graph_md",
    "media_manifest_md",
    "article_md",
    "validation_md",
}
REQUIRED_BOOLEAN_GATES = {
    "facts",
    "length",
    "citations",
    "media_match",
    "topic_alignment",
}
GENERATED_DISCLOSURE_MARKERS = (
    "模型生成",
    "ai-generated",
    "ai generated",
    "model-generated",
    "model generated",
)


def _mapping(value: Any, path: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{path} must be an object")
        return {}
    return value


def _list(value: Any, path: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        errors.append(f"{path} must be an array")
        return []
    return value


def _nonempty_string(value: Any, path: str, errors: list[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{path} must be a non-empty string")
        return ""
    return value.strip()


def _bounded_int(
    value: Any, path: str, minimum: int, maximum: int, errors: list[str]
) -> int | None:
    if type(value) is not int or not minimum <= value <= maximum:
        errors.append(f"{path} must be an integer from {minimum} to {maximum}")
        return None
    return value


def _collect_unique_ids(
    entries: list[Any], path: str, errors: list[str]
) -> tuple[set[str], list[dict[str, Any]]]:
    ids: set[str] = set()
    objects: list[dict[str, Any]] = []
    for index, raw_entry in enumerate(entries):
        entry_path = f"{path}[{index}]"
        entry = _mapping(raw_entry, entry_path, errors)
        if not entry:
            continue
        entry_id = _nonempty_string(entry.get("id"), f"{entry_path}.id", errors)
        if entry_id in ids:
            errors.append(f"{entry_path}.id duplicates {entry_id}")
        elif entry_id:
            ids.add(entry_id)
        objects.append(entry)
    return ids, objects


def _validate_id_refs(
    refs: Any,
    known_ids: set[str],
    path: str,
    errors: list[str],
    *,
    require_nonempty: bool = False,
) -> list[str]:
    values = _list(refs, path, errors)
    normalized: list[str] = []
    if require_nonempty and not values:
        errors.append(f"{path} must contain at least one id")
    for index, value in enumerate(values):
        ref = _nonempty_string(value, f"{path}[{index}]", errors)
        if ref and ref not in known_ids:
            errors.append(f"{path}[{index}] references unknown id {ref}")
        if ref:
            normalized.append(ref)
    return normalized


def validate_manifest(
    manifest: Any,
    *,
    manifest_path: Path | None = None,
    check_artifacts: bool = True,
) -> list[str]:
    errors: list[str] = []
    root = _mapping(manifest, "$", errors)
    if not root:
        return errors

    if root.get("schema_version") != 1:
        errors.append("schema_version must equal 1")
    _nonempty_string(root.get("topic"), "topic", errors)

    status = root.get("status")
    if status not in {"passed", "limited", "incomplete"}:
        errors.append("status must be passed, limited, or incomplete")

    research = _mapping(root.get("research"), "research", errors)
    iterations = _bounded_int(research.get("iterations"), "research.iterations", 1, 10, errors)
    saturated = research.get("saturated")
    if type(saturated) is not bool:
        errors.append("research.saturated must be a boolean")
    limit_reached = research.get("limit_reached")
    if type(limit_reached) is not bool:
        errors.append("research.limit_reached must be a boolean")
    elif iterations is not None and limit_reached != (iterations == 10):
        errors.append("research.limit_reached must be true exactly when iterations equals 10")
    _nonempty_string(research.get("stop_reason"), "research.stop_reason", errors)
    keyword_history = _list(
        research.get("keyword_history"), "research.keyword_history", errors
    )
    if not keyword_history:
        errors.append("research.keyword_history must contain at least one round")
    for index, keywords in enumerate(keyword_history):
        values = _list(keywords, f"research.keyword_history[{index}]", errors)
        if not values:
            errors.append(f"research.keyword_history[{index}] must not be empty")
        for keyword_index, keyword in enumerate(values):
            _nonempty_string(
                keyword,
                f"research.keyword_history[{index}][{keyword_index}]",
                errors,
            )

    source_ids, sources = _collect_unique_ids(
        _list(root.get("sources"), "sources", errors), "sources", errors
    )
    if not sources:
        errors.append("sources must contain at least one source")
    accessible_source_ids: set[str] = set()
    for index, source in enumerate(sources):
        path = f"sources[{index}]"
        source_id = source.get("id")
        _nonempty_string(source.get("title"), f"{path}.title", errors)
        _nonempty_string(source.get("url"), f"{path}.url", errors)
        if source.get("source_type") not in SOURCE_TYPES:
            errors.append(
                f"{path}.source_type must be one of {sorted(SOURCE_TYPES)}"
            )
        _nonempty_string(source.get("retrieved_at"), f"{path}.retrieved_at", errors)
        if type(source.get("accessible")) is not bool:
            errors.append(f"{path}.accessible must be a boolean")
        elif source.get("accessible") is True and isinstance(source_id, str):
            accessible_source_ids.add(source_id)

    claim_ids, claims = _collect_unique_ids(
        _list(root.get("claims"), "claims", errors), "claims", errors
    )
    if not claims:
        errors.append("claims must contain at least one objective claim")
    for index, claim in enumerate(claims):
        path = f"claims[{index}]"
        _nonempty_string(claim.get("text"), f"{path}.text", errors)
        refs = _validate_id_refs(
            claim.get("source_ids"),
            source_ids,
            f"{path}.source_ids",
            errors,
            require_nonempty=True,
        )
        for ref in refs:
            if ref not in accessible_source_ids:
                errors.append(f"{path}.source_ids references inaccessible source {ref}")
        if claim.get("objective") is not True:
            errors.append(f"{path}.objective must be true")
        if claim.get("confidence") not in CONFIDENCE_LEVELS:
            errors.append(
                f"{path}.confidence must be one of {sorted(CONFIDENCE_LEVELS)}"
            )

    clue_graph = _mapping(root.get("clue_graph"), "clue_graph", errors)
    _nonempty_string(clue_graph.get("primary_axis"), "clue_graph.primary_axis", errors)
    node_ids, nodes = _collect_unique_ids(
        _list(clue_graph.get("nodes"), "clue_graph.nodes", errors),
        "clue_graph.nodes",
        errors,
    )
    if not nodes:
        errors.append("clue_graph.nodes must contain at least one node")

    media_ids, media_items = _collect_unique_ids(
        _list(root.get("media"), "media", errors), "media", errors
    )

    for index, node in enumerate(nodes):
        path = f"clue_graph.nodes[{index}]"
        _nonempty_string(node.get("label"), f"{path}.label", errors)
        _validate_id_refs(
            node.get("claim_ids"),
            claim_ids,
            f"{path}.claim_ids",
            errors,
            require_nonempty=True,
        )
        _validate_id_refs(
            node.get("source_ids"), source_ids, f"{path}.source_ids", errors
        )
        _validate_id_refs(
            node.get("media_ids"), media_ids, f"{path}.media_ids", errors
        )

    edges = _list(clue_graph.get("edges"), "clue_graph.edges", errors)
    for index, raw_edge in enumerate(edges):
        path = f"clue_graph.edges[{index}]"
        edge = _mapping(raw_edge, path, errors)
        if not edge:
            continue
        source_node = _nonempty_string(edge.get("from"), f"{path}.from", errors)
        target_node = _nonempty_string(edge.get("to"), f"{path}.to", errors)
        _nonempty_string(edge.get("type"), f"{path}.type", errors)
        if source_node and source_node not in node_ids:
            errors.append(f"{path}.from references unknown node {source_node}")
        if target_node and target_node not in node_ids:
            errors.append(f"{path}.to references unknown node {target_node}")

    for index, media in enumerate(media_items):
        path = f"media[{index}]"
        origin = media.get("origin")
        if origin not in MEDIA_ORIGINS:
            errors.append(f"{path}.origin must be one of {sorted(MEDIA_ORIGINS)}")
        _nonempty_string(media.get("url_or_path"), f"{path}.url_or_path", errors)
        _nonempty_string(media.get("caption"), f"{path}.caption", errors)
        _nonempty_string(media.get("alt"), f"{path}.alt", errors)
        _validate_id_refs(
            media.get("node_ids"), node_ids, f"{path}.node_ids", errors
        )
        claim_refs = _validate_id_refs(
            media.get("claim_ids"), claim_ids, f"{path}.claim_ids", errors
        )
        supports_fact = media.get("supports_fact")
        if type(supports_fact) is not bool:
            errors.append(f"{path}.supports_fact must be a boolean")
        if origin == "generated":
            if supports_fact is not False:
                errors.append(f"{path}: generated media cannot support facts")
            if claim_refs:
                errors.append(f"{path}: generated media cannot reference claim_ids")
            disclosure = str(media.get("disclosure", "")).strip()
            if not any(marker in disclosure.lower() for marker in GENERATED_DISCLOSURE_MARKERS):
                errors.append(
                    f"{path}.disclosure must identify the image as model-generated"
                )
        elif supports_fact is True:
            _nonempty_string(media.get("source_url"), f"{path}.source_url", errors)

    draft = _mapping(root.get("draft"), "draft", errors)
    _nonempty_string(draft.get("path"), "draft.path", errors)
    length = _mapping(draft.get("length"), "draft.length", errors)
    _nonempty_string(length.get("method"), "draft.length.method", errors)
    minimum = length.get("min")
    maximum = length.get("max")
    actual = length.get("actual")
    for field, value in (("min", minimum), ("max", maximum), ("actual", actual)):
        if type(value) is not int or value < 0:
            errors.append(f"draft.length.{field} must be a non-negative integer")
    if type(minimum) is int and type(maximum) is int and minimum > maximum:
        errors.append("draft.length.min cannot exceed draft.length.max")
    measured_pass = (
        type(minimum) is int
        and type(maximum) is int
        and type(actual) is int
        and minimum <= actual <= maximum
    )
    if type(length.get("pass")) is not bool:
        errors.append("draft.length.pass must be a boolean")
    elif length.get("pass") != measured_pass:
        errors.append("draft.length.pass does not match min/max/actual")

    validation = _mapping(root.get("validation"), "validation", errors)
    for gate in sorted(REQUIRED_BOOLEAN_GATES):
        if type(validation.get(gate)) is not bool:
            errors.append(f"validation.{gate} must be a boolean")
    tone_result = validation.get("less_ai_tone")
    if tone_result not in TONE_RESULTS:
        errors.append(
            f"validation.less_ai_tone must be one of {sorted(TONE_RESULTS)}"
        )
    boundary_disclosed = validation.get("evidence_boundary_disclosed")
    if type(boundary_disclosed) is not bool:
        errors.append("validation.evidence_boundary_disclosed must be a boolean")

    _bounded_int(root.get("repair_cycles"), "repair_cycles", 0, 3, errors)

    artifacts = _mapping(root.get("artifacts"), "artifacts", errors)
    for artifact_key in sorted(REQUIRED_ARTIFACTS):
        artifact_value = _nonempty_string(
            artifacts.get(artifact_key), f"artifacts.{artifact_key}", errors
        )
        if check_artifacts and artifact_value:
            if manifest_path is None:
                errors.append("manifest_path is required when checking artifacts")
            else:
                artifact_path = (manifest_path.parent / artifact_value).resolve()
                if not artifact_path.is_file():
                    errors.append(
                        f"artifacts.{artifact_key} does not exist: {artifact_path}"
                    )

    if status == "passed":
        if saturated is not True:
            errors.append("passed runs require research.saturated=true")
        if length.get("pass") is not True:
            errors.append("passed runs require draft.length.pass=true")
        for gate in sorted(REQUIRED_BOOLEAN_GATES):
            if validation.get(gate) is not True:
                errors.append(f"passed runs require validation.{gate}=true")
        if tone_result not in {"passed", "not_applicable"}:
            errors.append(
                "passed runs require validation.less_ai_tone=passed or not_applicable"
            )
    elif status == "limited":
        if iterations != 10:
            errors.append("limited runs require research.iterations=10")
        if saturated is not False:
            errors.append("limited runs require research.saturated=false")
        if limit_reached is not True:
            errors.append("limited runs require research.limit_reached=true")
        if length.get("pass") is not True:
            errors.append("limited runs require draft.length.pass=true")
        for gate in sorted(REQUIRED_BOOLEAN_GATES):
            if validation.get(gate) is not True:
                errors.append(f"limited runs require validation.{gate}=true")
        if boundary_disclosed is not True:
            errors.append(
                "limited runs require validation.evidence_boundary_disclosed=true"
            )
        if tone_result not in {"passed", "not_applicable"}:
            errors.append(
                "limited runs require validation.less_ai_tone=passed or not_applicable"
            )
    elif status == "incomplete":
        errors.append("run status is incomplete")

    return errors


def _valid_fixture() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "topic": "fixture",
        "status": "passed",
        "research": {
            "iterations": 2,
            "saturated": True,
            "limit_reached": False,
            "stop_reason": "two stable rounds",
            "keyword_history": [["fixture"], ["fixture report"]],
        },
        "sources": [
            {
                "id": "S01",
                "title": "Official source",
                "url": "https://example.com/source",
                "source_type": "official",
                "retrieved_at": "2026-09-16",
                "accessible": True,
            }
        ],
        "claims": [
            {
                "id": "C01",
                "text": "A verifiable fact.",
                "source_ids": ["S01"],
                "objective": True,
                "confidence": "confirmed",
            }
        ],
        "clue_graph": {
            "primary_axis": "timeline",
            "nodes": [
                {
                    "id": "N01",
                    "label": "A clue",
                    "claim_ids": ["C01"],
                    "source_ids": ["S01"],
                    "media_ids": [],
                }
            ],
            "edges": [],
        },
        "media": [],
        "draft": {
            "path": "article.md",
            "length": {
                "method": "plain_content_characters",
                "min": 10,
                "max": 20,
                "actual": 15,
                "pass": True,
            },
        },
        "validation": {
            "facts": True,
            "length": True,
            "citations": True,
            "media_match": True,
            "topic_alignment": True,
            "evidence_boundary_disclosed": True,
            "less_ai_tone": "not_applicable",
        },
        "repair_cycles": 0,
        "artifacts": {
            "research_md": "research.md",
            "clue_graph_md": "clue-graph.md",
            "media_manifest_md": "media-manifest.md",
            "article_md": "article.md",
            "validation_md": "validation.md",
        },
    }


def run_self_test() -> int:
    valid = _valid_fixture()
    valid_errors = validate_manifest(valid, check_artifacts=False)
    if valid_errors:
        print("SELF-TEST FAILED: valid fixture was rejected", file=sys.stderr)
        for error in valid_errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    invalid = copy.deepcopy(valid)
    invalid["media"] = [
        {
            "id": "M01",
            "origin": "generated",
            "url_or_path": "generated.png",
            "caption": "A fake evidence image",
            "alt": "A generated image",
            "node_ids": ["N01"],
            "claim_ids": ["C01"],
            "supports_fact": True,
            "disclosure": "",
        }
    ]
    invalid["clue_graph"]["nodes"][0]["media_ids"] = ["M01"]
    invalid_errors = validate_manifest(invalid, check_artifacts=False)
    expected_markers = (
        "generated media cannot support facts",
        "generated media cannot reference claim_ids",
        "must identify the image as model-generated",
    )
    if not all(any(marker in error for error in invalid_errors) for marker in expected_markers):
        print("SELF-TEST FAILED: unsafe generated media was not rejected", file=sys.stderr)
        for error in invalid_errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    limited = copy.deepcopy(valid)
    limited["status"] = "limited"
    limited["research"]["iterations"] = 10
    limited["research"]["saturated"] = False
    limited["research"]["limit_reached"] = True
    limited_errors = validate_manifest(limited, check_artifacts=False)
    if limited_errors:
        print("SELF-TEST FAILED: valid limited fixture was rejected", file=sys.stderr)
        for error in limited_errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("SELF-TEST OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate an evidence-article-pipeline run.json file."
    )
    parser.add_argument("manifest", nargs="?", type=Path, help="Path to run.json")
    parser.add_argument(
        "--self-test", action="store_true", help="Run built-in positive and negative tests"
    )
    args = parser.parse_args()

    if args.self_test:
        return run_self_test()
    if args.manifest is None:
        parser.error("manifest is required unless --self-test is used")

    manifest_path = args.manifest.resolve()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"ERROR: manifest does not exist: {manifest_path}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"ERROR: invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}")
        return 2

    errors = validate_manifest(
        manifest, manifest_path=manifest_path, check_artifacts=True
    )
    if errors:
        print(f"FAILED: {len(errors)} validation error(s)")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"OK: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
