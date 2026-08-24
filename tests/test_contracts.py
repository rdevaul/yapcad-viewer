"""Executable checks for the initial viewer transport contracts."""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker


ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "contracts"
EXAMPLES = ROOT / "examples"


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _validator(name: str) -> Draft202012Validator:
    schema = _load(CONTRACTS / name)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def test_all_json_contract_files_are_valid_json_schemas_or_tool_documents():
    for path in sorted(CONTRACTS.glob("*.schema.json")):
        Draft202012Validator.check_schema(_load(path))

    tools = _load(CONTRACTS / "mcp-tools-v1.json")
    assert tools["schema"] == "yapcad-viewer-mcp-tools-v1"
    assert tools["tools"]


def test_session_snapshot_example_validates():
    _validator("session-v1.schema.json").validate(
        _load(EXAMPLES / "session-snapshot.json")
    )


def test_pose_command_example_validates():
    _validator("command-v1.schema.json").validate(
        _load(EXAMPLES / "set-pose-command.json")
    )


def test_state_changed_event_example_validates():
    _validator("event-v1.schema.json").validate(
        _load(EXAMPLES / "state-changed-event.json")
    )


def test_render_query_example_validates():
    _validator("query-v1.schema.json").validate(
        _load(EXAMPLES / "render-query.json")
    )


def test_command_contract_rejects_unversioned_mutation():
    command = _load(EXAMPLES / "set-pose-command.json")
    del command["expectedRevision"]
    errors = list(_validator("command-v1.schema.json").iter_errors(command))
    assert errors


def test_mcp_tool_names_are_unique_and_mutations_are_revision_checked():
    tools = _load(CONTRACTS / "mcp-tools-v1.json")["tools"]
    names = [tool["name"] for tool in tools]
    assert len(names) == len(set(names))
    assert all(name.startswith("viewer_") for name in names)

    exempt = {"viewer_open_package"}
    for tool in tools:
        if not tool["readOnlyHint"] and tool["name"] not in exempt:
            assert "expected_revision" in tool["inputSchema"]["required"]

    revision_pinned_queries = {"viewer_measure_distance", "viewer_render"}
    for tool in tools:
        if tool["name"] in revision_pinned_queries:
            assert tool["readOnlyHint"] is True
            assert "at_revision" in tool["inputSchema"]["required"]


def test_contracts_do_not_name_an_agent_runtime_or_model_provider():
    text = "\n".join(
        path.read_text(encoding="utf-8") for path in CONTRACTS.glob("*.json")
    ).lower()
    for forbidden in ("openclaw", "openai", "anthropic", "gemini"):
        assert forbidden not in text
