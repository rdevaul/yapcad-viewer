"""Tests for content-addressed component assets and semantic scenes."""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from yapcad_viewer.application import (
    LoadedProductPackage,
    PackageSessionError,
    PackageSessionService,
    PackageSourcePolicy,
)
from yapcad_viewer.rendering import (
    ContentAddressedAssetStore,
    MeshData,
    SceneService,
    TessellationPolicy,
    YapcadGeometryAdapter,
)
from yapcad_viewer.rendering.scene import mesh_to_glb


ROOT = Path(__file__).resolve().parents[1]


class ScenePackageAdapter:
    def load(self, package_root: Path, *, strict: bool) -> LoadedProductPackage:
        component = {
            "id": "wheel", "name": "Wheel", "description": "Printed wheel",
            "disposition": "make", "quantityPerInstance": 1, "unit": "each",
            "material": "petg", "geometry": {"hash": "sha256:" + "a" * 64},
        }
        cots = {
            "id": "label", "name": "Label", "description": "Non-geometric COTS label",
            "disposition": "buy", "quantityPerInstance": 1, "unit": "each",
        }
        identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
        shifted = [[1, 0, 0, 100], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
        return LoadedProductPackage(
            manifest={
                "schema": "ycpkg-spec-v0.2", "name": "Scene fixture", "version": "0.1",
                "components": [component, cots],
                "instances": [
                    {"id": "left_wheel", "component": "wheel"},
                    {"id": "right_wheel", "component": "wheel"},
                    {"id": "label", "component": "label"},
                ],
                "assembly": {"rootPart": "left_wheel"},
                "materials": {"petg": {"source": {"type": "custom"}}},
            },
            assembly={
                "rootPart": "left_wheel",
                "parts": {
                    "left_wheel": {"component": "wheel", "transform": identity, "datums": []},
                    "right_wheel": {"component": "wheel", "transform": shifted, "datums": []},
                    "label": {"component": "label", "transform": identity, "datums": []},
                },
                "mates": [], "jointValues": {},
            },
            bom={"items": [
                {"item": 1, "component": "wheel", "partNumber": None, "revision": None,
                 "description": "Wheel", "disposition": "make", "quantity": 2, "unit": "each"},
                {"item": 2, "component": "label", "partNumber": None, "revision": None,
                 "description": "Label", "disposition": "buy", "quantity": 1, "unit": "each"},
            ]},
            valid=True,
            validation_messages=("OK: valid",),
        )


class CountingGeometryAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, float, float]] = []

    def cache_fingerprint(self) -> str:
        return "test-kernel-v1"

    def component_mesh(
        self, package_root: Path, component_id: str, policy: TessellationPolicy,
    ) -> MeshData:
        self.calls.append((
            component_id, policy.linear_deflection_mm, policy.angular_deflection_rad,
        ))
        return _tetrahedron()


def _tetrahedron() -> MeshData:
    return MeshData(
        positions=((0, 0, 0), (10, 0, 0), (0, 10, 0), (0, 0, 10)),
        normals=((0, 0, -1), (0, 0, -1), (0, 0, -1), (0, 0, 1)),
        triangles=((0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)),
        source_representation="brep",
    )


def _open_scene(tmp_path: Path):
    package_root = tmp_path / "fixture.ycpkg"
    package_root.mkdir()
    (package_root / "manifest.yaml").write_text("schema: ycpkg-spec-v0.2\n")
    sessions = PackageSessionService(PackageSourcePolicy((tmp_path,)), ScenePackageAdapter())
    snapshot = sessions.open_package(package_root)
    geometry = CountingGeometryAdapter()
    assets = ContentAddressedAssetStore(tmp_path / "cache")
    return snapshot, SceneService(sessions, assets, geometry), geometry, assets


def _glb_json(payload: bytes) -> dict:
    magic, version, total = struct.unpack_from("<4sII", payload)
    assert magic == b"glTF"
    assert version == 2
    assert total == len(payload)
    json_length, chunk_type = struct.unpack_from("<I4s", payload, 12)
    assert chunk_type == b"JSON"
    return json.loads(payload[20:20 + json_length].decode("utf-8"))


def test_scene_contract_reuses_one_asset_for_repeated_instances(tmp_path: Path):
    snapshot, service, geometry, _ = _open_scene(tmp_path)
    scene = service.build_scene(snapshot["sessionId"], at_revision=0)
    schema = json.loads((ROOT / "contracts/scene-v1.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(scene)

    assert len(scene["assets"]) == 1
    wheel_nodes = [node for node in scene["nodes"] if node["componentId"] == "wheel"]
    assert len(wheel_nodes) == 2
    assert wheel_nodes[0]["assetId"] == wheel_nodes[1]["assetId"]
    assert scene["nodes"][1]["transform"][12:15] == [100, 0, 0]
    assert scene["nodes"][2]["assetId"] is None
    assert scene["diagnostics"][0]["entityIds"] == ["label"]
    assert geometry.calls == [("wheel", 0.25, 0.5)]


def test_second_scene_build_uses_derivation_cache_without_tessellating(tmp_path: Path):
    snapshot, service, geometry, _ = _open_scene(tmp_path)
    first = service.build_scene(snapshot["sessionId"], at_revision=0)
    second = service.build_scene(snapshot["sessionId"], at_revision=0)
    assert second == first
    assert geometry.calls == [("wheel", 0.25, 0.5)]


def test_policy_is_part_of_derivation_but_identical_glb_has_same_content_id(tmp_path: Path):
    snapshot, service, geometry, _ = _open_scene(tmp_path)
    coarse = service.build_scene(
        snapshot["sessionId"], at_revision=0,
        policy=TessellationPolicy(linear_deflection_mm=0.5),
    )
    fine = service.build_scene(
        snapshot["sessionId"], at_revision=0,
        policy=TessellationPolicy(linear_deflection_mm=0.1),
    )
    assert coarse["assets"][0]["derivationDigest"] != fine["assets"][0]["derivationDigest"]
    assert coarse["assets"][0]["id"] == fine["assets"][0]["id"]
    assert geometry.calls == [("wheel", 0.5, 0.5), ("wheel", 0.1, 0.5)]


def test_asset_digest_matches_glb_bytes_and_semantic_metadata(tmp_path: Path):
    snapshot, service, _, _ = _open_scene(tmp_path)
    scene = service.build_scene(snapshot["sessionId"], at_revision=0)
    asset = scene["assets"][0]
    payload = service.read_asset(asset["id"])
    assert "sha256:" + hashlib.sha256(payload).hexdigest() == asset["id"]
    document = _glb_json(payload)
    assert document["asset"]["version"] == "2.0"
    assert document["nodes"][0]["extras"]["componentId"] == "wheel"
    assert document["extras"] == {"sourceRepresentation": "brep", "units": "millimetre"}
    assert document["accessors"][0]["min"] == [0, 0, 0]
    assert document["accessors"][0]["max"] == [10, 10, 10]


def test_tampered_asset_is_rejected(tmp_path: Path):
    snapshot, service, _, assets = _open_scene(tmp_path)
    scene = service.build_scene(snapshot["sessionId"], at_revision=0)
    asset_id = scene["assets"][0]["id"]
    object_path = assets.objects / f"{asset_id.removeprefix('sha256:')}.glb"
    object_path.write_bytes(b"tampered")
    with pytest.raises(PackageSessionError) as failed:
        service.read_asset(asset_id)
    assert failed.value.code == "geometry_unavailable"

    with pytest.raises(PackageSessionError) as malformed:
        service.read_asset("not-a-digest")
    assert malformed.value.code == "geometry_unavailable"


def test_tampered_derivation_metadata_is_not_trusted(tmp_path: Path):
    snapshot, service, geometry, assets = _open_scene(tmp_path)
    scene = service.build_scene(snapshot["sessionId"], at_revision=0)
    derivation = scene["assets"][0]["derivationDigest"].removeprefix("sha256:")
    index_path = assets.derivations / f"{derivation}.json"
    record = json.loads(index_path.read_text())
    record["sourceRepresentation"] = "embedded-mesh"
    index_path.write_text(json.dumps(record))

    rebuilt = service.build_scene(snapshot["sessionId"], at_revision=0)
    assert rebuilt == scene
    assert geometry.calls == [("wheel", 0.25, 0.5), ("wheel", 0.25, 0.5)]


def test_scene_is_revision_pinned(tmp_path: Path):
    snapshot, service, _, _ = _open_scene(tmp_path)
    with pytest.raises(PackageSessionError) as conflict:
        service.build_scene(snapshot["sessionId"], at_revision=1)
    assert conflict.value.code == "revision_conflict"


def test_asset_cache_cannot_modify_authoritative_package(tmp_path: Path):
    package_root = tmp_path / "fixture.ycpkg"
    package_root.mkdir()
    (package_root / "manifest.yaml").write_text("schema: ycpkg-spec-v0.2\n")
    sessions = PackageSessionService(PackageSourcePolicy((tmp_path,)), ScenePackageAdapter())
    snapshot = sessions.open_package(package_root)
    service = SceneService(
        sessions,
        ContentAddressedAssetStore(package_root / "derived-cache"),
        CountingGeometryAdapter(),
    )
    with pytest.raises(PackageSessionError) as denied:
        service.build_scene(snapshot["sessionId"], at_revision=0)
    assert denied.value.code == "permission_denied"
    assert not (package_root / "derived-cache").exists()


def test_glb_encoding_is_deterministic():
    first = mesh_to_glb(_tetrahedron(), component_id="wheel")
    second = mesh_to_glb(_tetrahedron(), component_id="wheel")
    assert first == second
    assert len(first) % 4 == 0


def test_real_yapcad_component_geometry_when_available(tmp_path: Path):
    package = pytest.importorskip("yapcad.package")
    if not hasattr(package, "create_package_from_assembly"):
        pytest.skip("installed yapCAD predates ycpkg-spec-v0.2")
    from yapcad.assembly import Assembly, PartDefinition
    from yapcad.geom3d_util import prism

    assembly = Assembly("scene_fixture")
    definition = PartDefinition("bracket")
    definition.component_id = "bracket"
    definition.component_name = "Bracket"
    definition.disposition = "make"
    definition.manufacturing = {"process": "FDM"}
    assembly.add_part(definition, "left", geometry=prism(10, 8, 4))
    assembly.add_part(definition, "right", geometry=prism(10, 8, 4))
    package_root = tmp_path / "generated.ycpkg"
    package.create_package_from_assembly(
        assembly, package_root, name="Generated scene", version="0.1", root_part="left",
    )

    from yapcad_viewer.application import YapcadPackageAdapter
    sessions = PackageSessionService(PackageSourcePolicy((tmp_path,)), YapcadPackageAdapter())
    snapshot = sessions.open_package(package_root)
    service = SceneService(
        sessions, ContentAddressedAssetStore(tmp_path / "cache"), YapcadGeometryAdapter(),
    )
    scene = service.build_scene(snapshot["sessionId"], at_revision=0)
    assert len(scene["assets"]) == 1
    assert len(scene["nodes"]) == 2
    assert scene["assets"][0]["sourceRepresentation"] in {"brep", "embedded-mesh"}
    assert _glb_json(service.read_asset(scene["assets"][0]["id"]))["meshes"][0]["name"] == "bracket"


def test_real_authoritative_brep_uses_requested_tessellation(tmp_path: Path):
    pytest.importorskip("yapcad.package")
    from yapcad.brep import BrepSolid, attach_brep_to_solid, occ_available
    if not occ_available():
        pytest.skip("pythonocc-core not available")
    from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox
    from yapcad.assembly import Assembly, PartDefinition
    from yapcad.geom3d import solid
    from yapcad.package import create_package_from_assembly

    brep = BrepSolid(BRepPrimAPI_MakeBox(10, 8, 4).Shape())
    geometry = solid([brep.tessellate()])
    attach_brep_to_solid(geometry, brep)
    definition = PartDefinition("brep-bracket")
    definition.component_id = "brep-bracket"
    definition.component_name = "BREP bracket"
    definition.disposition = "make"
    definition.manufacturing = {"process": "machining"}
    assembly = Assembly("brep_scene")
    assembly.add_part(definition, "bracket", geometry=geometry)
    package_root = tmp_path / "brep.ycpkg"
    create_package_from_assembly(
        assembly, package_root, name="BREP scene", version="0.1", root_part="bracket",
    )

    from yapcad_viewer.application import YapcadPackageAdapter
    sessions = PackageSessionService(PackageSourcePolicy((tmp_path,)), YapcadPackageAdapter())
    snapshot = sessions.open_package(package_root)
    service = SceneService(sessions, ContentAddressedAssetStore(tmp_path / "cache"))
    policy = TessellationPolicy(linear_deflection_mm=0.15, angular_deflection_rad=0.2)
    scene = service.build_scene(snapshot["sessionId"], at_revision=0, policy=policy)
    assert scene["assets"][0]["sourceRepresentation"] == "brep"
    assert scene["assets"][0]["tessellation"] == policy.to_dict()
    assert _glb_json(service.read_asset(scene["assets"][0]["id"]))["extras"][
        "sourceRepresentation"
    ] == "brep"
