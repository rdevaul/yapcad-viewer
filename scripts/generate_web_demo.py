"""Generate the browser demo from the standalone YapRover suspension DSL."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import tempfile
from pathlib import Path

from yapcad.dsl import compile_and_run
from yapcad.dsl.runtime.builtins import call_builtin
from yapcad.dsl.runtime.values import float_val, list_val, solid_val, string_val
from yapcad.dsl.types import FLOAT, STRING
from yapcad.package import create_package_from_assembly

from yapcad_viewer.application import (
    PackageSessionService,
    PackageSourcePolicy,
    YapcadPackageAdapter,
)
from yapcad_viewer.rendering import ContentAddressedAssetStore, SceneService


PARTS = (
    ("CHASSIS", "chassis"),
    ("ROCKER", "left_rocker"),
    ("ROCKER", "right_rocker"),
    ("BOGIE", "left_bogie"),
    ("BOGIE", "right_bogie"),
    ("WHEEL", "left_front_wheel"),
    ("WHEEL", "left_middle_wheel"),
    ("WHEEL", "left_rear_wheel"),
    ("WHEEL", "right_front_wheel"),
    ("WHEEL", "right_middle_wheel"),
    ("WHEEL", "right_rear_wheel"),
)
MATES = (
    ("left_rocker_pivot", "chassis", "left_rocker", "left_rocker", "chassis_pivot"),
    ("right_rocker_pivot", "chassis", "right_rocker", "right_rocker", "chassis_pivot"),
    ("left_bogie_pivot", "left_rocker", "left_bogie", "bogie_pivot", "rocker_pivot"),
    ("right_bogie_pivot", "right_rocker", "right_bogie", "bogie_pivot", "rocker_pivot"),
    ("left_front_axle", "left_rocker", "left_front_wheel", "front_axle", "axle"),
    ("left_middle_axle", "left_bogie", "left_middle_wheel", "middle_axle", "axle"),
    ("left_rear_axle", "left_bogie", "left_rear_wheel", "rear_axle", "axle"),
    ("right_front_axle", "right_rocker", "right_front_wheel", "front_axle", "axle"),
    ("right_middle_axle", "right_bogie", "right_middle_wheel", "middle_axle", "axle"),
    ("right_rear_axle", "right_bogie", "right_rear_wheel", "rear_axle", "axle"),
)
COMPONENTS = {
    "CHASSIS": ("chassis-proxy", "Chassis tub"),
    "ROCKER": ("rocker-proxy", "Rocker link"),
    "BOGIE": ("bogie-proxy", "Bogie link"),
    "WHEEL": ("wheel-proxy", "Wheel and hub"),
}
FIXED_SESSION_ID = "77777777-7777-4777-8777-777777777777"


def digest(value: str | bytes) -> str:
    payload = value.encode("utf-8") if isinstance(value, str) else value
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def build_assembly(source: str):
    solids = {}
    for command in COMPONENTS:
        result = compile_and_run(source, command, {})
        if not result.success:
            raise RuntimeError(result.error_message)
        solids[command] = result.geometry

    handle = call_builtin("assembly", [string_val("yaprover_web_demo")])
    for command, instance in PARTS:
        call_builtin("add_part", [handle, solid_val(solids[command]), string_val(instance)])
        definition = handle.data.parts[instance]
        component_id, component_name = COMPONENTS[command]
        definition.component_id = component_id
        definition.component_name = component_name
        definition.description = "YapRover suspension showcase component"
        definition.disposition = "make"
        definition.material = "petg"
        definition.revision = "A"
        definition.manufacturing = {"process": "FDM", "material": "PET-G"}
    for name, parent, child, parent_datum, child_datum in MATES:
        call_builtin("add_named_mate", [
            handle, string_val(name), string_val("revolute"),
            string_val(parent), string_val(parent_datum),
            string_val(child), string_val(child_datum),
        ])
    call_builtin("add_joint_coupling", [
        handle, string_val("rocker_differential"),
        string_val("right_rocker_pivot"),
        list_val([string_val("left_rocker_pivot")], STRING),
        list_val([float_val(-1.0)], FLOAT), float_val(0.0),
    ])
    for name, minimum, maximum in (
        ("left_rocker_pivot", -18.0, 18.0),
        ("right_rocker_pivot", -18.0, 18.0),
        ("left_bogie_pivot", -35.0, 38.0),
        ("right_bogie_pivot", -35.0, 38.0),
    ):
        call_builtin("set_mate_limits", [
            handle, string_val(name),
            float_val(math.radians(minimum)), float_val(math.radians(maximum)),
        ])
    solved = handle.data.solve("chassis", {"left_rocker_pivot": math.radians(8.0)})
    if not solved.success:
        raise RuntimeError(str(solved.errors))
    return handle.data


def canonicalize(session: dict, scene: dict) -> None:
    session["sessionId"] = FIXED_SESSION_ID
    session["package"]["digest"] = digest("yaprover-web-demo-v1")
    session["selection"] = ["left_rocker"]
    component_assets = {}
    for component in session["components"]:
        if component.get("assetDigest"):
            stable_digest = digest(f"demo-component:{component['id']}")
            component["assetDigest"] = stable_digest
            component_assets[component["id"]] = stable_digest
    for part in session["parts"]:
        if part.get("assetDigest") and part["componentId"] in component_assets:
            part["assetDigest"] = component_assets[part["componentId"]]
    scene["sessionId"] = FIXED_SESSION_ID
    for asset in scene["assets"]:
        asset["derivationDigest"] = digest(
            f"demo-derivation:{asset['componentId']}:{asset['tessellation']}"
        )
        asset["generatorFingerprint"] = "yapCAD demo fixture; OpenCASCADE-derived"
    scene.pop("digest", None)
    encoded = json.dumps(scene, sort_keys=True, separators=(",", ":")).encode("utf-8")
    scene["digest"] = digest(encoded)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--yaprover-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source_path = args.yaprover_root / "designs" / "yaprover_suspension.dsl"
    assembly = build_assembly(source_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(prefix="yaprover-web-demo-") as temporary:
        root = Path(temporary)
        package_root = root / "yaprover-demo.ycpkg"
        create_package_from_assembly(
            assembly,
            package_root,
            name="YapRover suspension prototype",
            version="0.1.0",
            root_part="chassis",
            materials={
                "petg": {
                    "source": {"type": "custom", "custom": {"notes": "PET-G prototype"}},
                    "visual": {"color": [0.16, 0.58, 0.69], "metallic": 0.0, "roughness": 0.55},
                },
            },
        )
        sessions = PackageSessionService(PackageSourcePolicy((root,)), YapcadPackageAdapter())
        session = sessions.open_package(package_root)
        assets = ContentAddressedAssetStore(root / "cache")
        scenes = SceneService(sessions, assets)
        scene = scenes.build_scene(session["sessionId"], at_revision=0)
        canonicalize(session, scene)

        output = args.output
        asset_output = output / "assets"
        asset_output.mkdir(parents=True, exist_ok=True)
        for old in asset_output.glob("*.glb"):
            old.unlink()
        for asset in scene["assets"]:
            target = asset_output / f"{asset['id'].removeprefix('sha256:')}.glb"
            target.write_bytes(scenes.read_asset(asset["id"]))
        output.mkdir(parents=True, exist_ok=True)
        (output / "session.json").write_text(
            json.dumps(session, indent=2, sort_keys=False) + "\n", encoding="utf-8",
        )
        (output / "scene.json").write_text(
            json.dumps(scene, indent=2, sort_keys=False) + "\n", encoding="utf-8",
        )


if __name__ == "__main__":
    main()
