"""Acceptance tests for the read-only PackageSession application slice."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from yapcad_viewer.application import (
    LoadedProductPackage,
    PackageSessionError,
    PackageSessionService,
    PackageSourcePolicy,
    YapcadPackageAdapter,
)


ROOT = Path(__file__).resolve().parents[1]


class FixtureAdapter:
    def __init__(self, *, valid: bool = True) -> None:
        self.valid = valid
        self.strict_values: list[bool] = []

    def load(self, package_root: Path, *, strict: bool) -> LoadedProductPackage:
        self.strict_values.append(strict)
        if not self.valid:
            raise PackageSessionError(
                "validation_failed", "package failed yapCAD validation",
                diagnostics=[{"code": "package_error", "message": "bad hash", "entityIds": []}],
            )
        return LoadedProductPackage(
            manifest={
                "schema": "ycpkg-spec-v0.2", "name": "Test rover", "version": "0.1.0",
                "components": [
                    {"id": "chassis-tub", "name": "Chassis tub", "description": "Printed",
                     "disposition": "make", "quantityPerInstance": 1, "unit": "each",
                     "partNumber": "YR-001", "revision": "A", "material": "petg",
                     "manufacturing": {"process": "FDM"}, "geometry": {"hash": "a" * 64}},
                    {"id": "bearing-608", "name": "608 bearing", "description": "COTS",
                     "disposition": "buy", "quantityPerInstance": 2, "unit": "each",
                     "partNumber": "608-2RS", "procurement": {"specification": "8x22x7 mm"},
                     "geometry": {"hash": "sha256:" + "b" * 64}},
                ],
                "instances": [{"id": "chassis", "component": "chassis-tub"},
                              {"id": "left_bearings", "component": "bearing-608"}],
                "assembly": {"rootPart": "chassis"},
                "materials": {"petg": {"source": {"type": "custom"}}},
            },
            assembly={
                "rootPart": "chassis",
                "parts": {
                    "chassis": {"component": "chassis-tub", "transform": _translation(0, 0, 0),
                                "datums": [{"id": "pivot", "kind": "axis", "origin": [0, 0, 0], "direction": [0, 1, 0]}]},
                    "left_bearings": {"component": "bearing-608", "transform": _translation(20, 155, 140),
                                      "datums": [{"id": "axis", "kind": "axis", "origin": [0, 0, 0], "direction": [0, 1, 0]}]},
                },
                "mates": [{"id": "left_pivot", "kind": "revolute", "partA": "chassis",
                           "datumA": "pivot", "partB": "left_bearings", "datumB": "axis",
                           "offset": 0, "angle": 0,
                           "limits": {"min_value": -0.3, "max_value": 0.3}}],
                "jointValues": {"left_pivot": 0.1},
            },
            bom={"items": [
                {"item": 1, "component": "chassis-tub", "partNumber": "YR-001", "revision": "A",
                 "description": "Chassis tub", "disposition": "make", "quantity": 1, "unit": "each"},
                {"item": 2, "component": "bearing-608", "partNumber": "608-2RS", "revision": None,
                 "description": "608 bearing", "disposition": "buy", "quantity": 2, "unit": "each"},
            ]},
            valid=True,
            validation_messages=("OK: package passed validation", "WARNING: review prototype material"),
        )


def _translation(x: float, y: float, z: float) -> list[list[float]]:
    return [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]]


def _package(tmp_path: Path) -> Path:
    root = tmp_path / "rover.ycpkg"
    root.mkdir()
    (root / "manifest.yaml").write_text("schema: ycpkg-spec-v0.2\n", encoding="utf-8")
    return root


def _service(tmp_path: Path, adapter=None) -> PackageSessionService:
    return PackageSessionService(PackageSourcePolicy((tmp_path,), max_package_bytes=1024 * 1024),
                                 adapter=adapter or FixtureAdapter())


def test_open_builds_contract_valid_semantic_snapshot(tmp_path: Path):
    adapter = FixtureAdapter()
    snapshot = _service(tmp_path, adapter).open_package(_package(tmp_path))
    schema = json.loads((ROOT / "contracts/session-v1.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(snapshot)
    assert snapshot["revision"] == 0
    assert snapshot["package"]["rootPartId"] == "chassis"
    assert snapshot["package"]["digest"].startswith("sha256:")
    assert [item["disposition"] for item in snapshot["components"]] == ["make", "buy"]
    assert snapshot["bom"]["items"][1]["componentId"] == "bearing-608"
    assert snapshot["parts"][1]["parentId"] == "chassis"
    assert snapshot["parts"][1]["transform"][12:15] == [20, 155, 140]
    assert snapshot["parts"][0]["datums"][0]["id"] == "pivot"
    assert snapshot["mates"][0]["datumB"] == "axis"
    assert snapshot["joints"][0] == {"id": "left_pivot", "kind": "revolute", "value": 0.1,
                                      "unit": "radian", "minimum": -0.3, "maximum": 0.3}
    assert snapshot["validation"]["warnings"][0]["code"] == "package_warning"
    assert adapter.strict_values == [True]


def test_snapshot_results_cannot_mutate_session_state(tmp_path: Path):
    service = _service(tmp_path)
    opened = service.open_package(_package(tmp_path))
    opened["parts"][0]["visible"] = False
    opened["materials"]["petg"]["source"]["type"] = "vendor"
    current = service.get_snapshot(opened["sessionId"])
    assert current["parts"][0]["visible"] is True
    assert current["materials"]["petg"]["source"]["type"] == "custom"


def test_close_requires_current_revision_and_removes_session(tmp_path: Path):
    service = _service(tmp_path)
    opened = service.open_package(_package(tmp_path))
    with pytest.raises(PackageSessionError, match="expected revision") as conflict:
        service.close_session(opened["sessionId"], expected_revision=1)
    assert conflict.value.code == "revision_conflict"
    service.close_session(opened["sessionId"], expected_revision=0)
    with pytest.raises(PackageSessionError) as missing:
        service.get_snapshot(opened["sessionId"])
    assert missing.value.code == "unknown_session"


def test_source_policy_rejects_outside_root_wrong_suffix_and_symlinks(tmp_path: Path):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    service = _service(allowed)
    outside = _package(tmp_path)
    with pytest.raises(PackageSessionError) as denied:
        service.open_package(outside)
    assert denied.value.code == "permission_denied"
    wrong_suffix = allowed / "rover"
    wrong_suffix.mkdir()
    with pytest.raises(PackageSessionError) as invalid:
        service.open_package(wrong_suffix)
    assert invalid.value.code == "invalid_package"
    linked = allowed / "linked.ycpkg"
    linked.symlink_to(outside, target_is_directory=True)
    with pytest.raises(PackageSessionError) as symlinked:
        service.open_package(linked)
    assert symlinked.value.code == "permission_denied"


def test_failed_validation_does_not_create_a_session(tmp_path: Path):
    service = _service(tmp_path, FixtureAdapter(valid=False))
    with pytest.raises(PackageSessionError) as failed:
        service.open_package(_package(tmp_path))
    assert failed.value.code == "validation_failed"
    assert failed.value.to_dict()["diagnostics"][0]["message"] == "bad hash"


def test_package_digest_changes_when_member_content_changes(tmp_path: Path):
    package = _package(tmp_path)
    service = _service(tmp_path)
    first = service.open_package(package)["package"]["digest"]
    (package / "manifest.yaml").write_text("schema: ycpkg-spec-v0.2\nname: changed\n")
    second = service.open_package(package)["package"]["digest"]
    assert first != second


def test_open_rejects_a_package_changed_during_validation(tmp_path: Path):
    class MutatingAdapter(FixtureAdapter):
        def load(self, package_root: Path, *, strict: bool) -> LoadedProductPackage:
            loaded = super().load(package_root, strict=strict)
            (package_root / "manifest.yaml").write_text("changed: true\n", encoding="utf-8")
            return loaded

    with pytest.raises(PackageSessionError) as changed:
        _service(tmp_path, MutatingAdapter()).open_package(_package(tmp_path))
    assert changed.value.code == "invalid_package"
    assert "changed while" in changed.value.message


def test_real_yapcad_generated_product_package_when_available(tmp_path: Path):
    package = pytest.importorskip("yapcad.package")
    if not hasattr(package, "create_package_from_assembly"):
        pytest.skip("installed yapCAD predates ycpkg-spec-v0.2")
    from yapcad.assembly import Assembly, PartDefinition
    from yapcad.geom3d_util import prism
    assembly = Assembly("fixture")
    definition = PartDefinition("printed-bracket")
    definition.component_id = "printed-bracket"
    definition.component_name = "Printed bracket"
    definition.disposition = "make"
    definition.material = "petg"
    definition.manufacturing = {"process": "FDM"}
    assembly.add_part(definition, "bracket", geometry=prism(10, 8, 4))
    package_root = tmp_path / "generated.ycpkg"
    package.create_package_from_assembly(assembly, package_root, name="Generated fixture",
                                         version="0.1.0", root_part="bracket")
    snapshot = _service(tmp_path, YapcadPackageAdapter()).open_package(package_root)
    assert snapshot["package"]["name"] == "Generated fixture"
    assert snapshot["components"][0]["disposition"] == "make"
    assert snapshot["parts"][0]["componentId"] == "printed-bracket"
