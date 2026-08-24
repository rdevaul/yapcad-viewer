"""Content-addressed tessellation, GLB generation, and scene extraction."""

from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from yapcad_viewer.application import PackageSessionError, PackageSessionService


SCENE_SCHEMA = "yapcad-viewer-scene-v1"
EXPORTER_VERSION = "yapcad-viewer-glb-v1"


@dataclass(frozen=True)
class TessellationPolicy:
    """Reviewed inputs that affect derived component meshes."""

    linear_deflection_mm: float = 0.25
    angular_deflection_rad: float = 0.5

    def __post_init__(self) -> None:
        if not math.isfinite(self.linear_deflection_mm) or self.linear_deflection_mm <= 0:
            raise ValueError("linear deflection must be a positive finite value")
        if not math.isfinite(self.angular_deflection_rad) or self.angular_deflection_rad <= 0:
            raise ValueError("angular deflection must be a positive finite value")

    def to_dict(self) -> dict[str, Any]:
        return {
            "linearDeflectionMm": self.linear_deflection_mm,
            "angularDeflectionRad": self.angular_deflection_rad,
        }


@dataclass(frozen=True)
class MeshData:
    positions: tuple[tuple[float, float, float], ...]
    normals: tuple[tuple[float, float, float], ...]
    triangles: tuple[tuple[int, int, int], ...]
    source_representation: str

    def __post_init__(self) -> None:
        if not self.positions or not self.triangles:
            raise ValueError("mesh must contain vertices and triangles")
        if len(self.positions) != len(self.normals):
            raise ValueError("mesh positions and normals must have equal length")
        if self.source_representation not in {"brep", "embedded-mesh"}:
            raise ValueError("unknown source representation")
        vertex_count = len(self.positions)
        if any(index < 0 or index >= vertex_count for face in self.triangles for index in face):
            raise ValueError("mesh triangle references an invalid vertex")
        values = [value for vector in (*self.positions, *self.normals) for value in vector]
        if not all(math.isfinite(value) for value in values):
            raise ValueError("mesh contains non-finite coordinates")


class GeometryAdapter(Protocol):
    def cache_fingerprint(self) -> str: ...

    def component_mesh(
        self, package_root: Path, component_id: str, policy: TessellationPolicy,
    ) -> MeshData: ...


@dataclass(frozen=True)
class StoredAsset:
    derivation_digest: str
    content_digest: str
    byte_length: int
    source_representation: str
    path: Path


class ContentAddressedAssetStore:
    """Store immutable GLB objects and small deterministic derivation indices."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).expanduser().resolve()
        self.objects = self.root / "objects"
        self.derivations = self.root / "derivations"

    def find(self, derivation_digest: str) -> StoredAsset | None:
        index_path = self.derivations / f"{_hex_digest(derivation_digest)}.json"
        if not index_path.is_file():
            return None
        try:
            record = json.loads(index_path.read_text(encoding="utf-8"))
            if not isinstance(record, dict):
                return None
            content_digest = record["contentDigest"]
            object_path = self.objects / f"{_hex_digest(content_digest)}.glb"
            payload = object_path.read_bytes()
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            return None
        if _sha256(payload) != content_digest or len(payload) != record.get("byteLength"):
            return None
        try:
            source_representation = _glb_source_representation(payload)
        except ValueError:
            return None
        if source_representation != record.get("sourceRepresentation"):
            return None
        return StoredAsset(
            derivation_digest, content_digest, len(payload),
            source_representation, object_path,
        )

    def put(
        self, derivation_digest: str, payload: bytes, source_representation: str,
    ) -> StoredAsset:
        try:
            self.objects.mkdir(parents=True, exist_ok=True)
            self.derivations.mkdir(parents=True, exist_ok=True)
            content_digest = _sha256(payload)
            object_path = self.objects / f"{_hex_digest(content_digest)}.glb"
            if object_path.exists():
                if object_path.read_bytes() != payload:
                    raise PackageSessionError("job_failed", "asset digest collision")
            else:
                _atomic_write(object_path, payload)
            record = {
                "contentDigest": content_digest,
                "byteLength": len(payload),
                "sourceRepresentation": source_representation,
            }
            index_path = self.derivations / f"{_hex_digest(derivation_digest)}.json"
            _atomic_write(
                index_path,
                (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"),
            )
        except OSError as exc:
            raise PackageSessionError("job_failed", f"failed to store render asset: {exc}") from exc
        return StoredAsset(
            derivation_digest, content_digest, len(payload), source_representation, object_path,
        )

    def read(self, content_digest: str) -> bytes:
        try:
            path = self.objects / f"{_hex_digest(content_digest)}.glb"
            payload = path.read_bytes()
        except (OSError, ValueError) as exc:
            raise PackageSessionError("geometry_unavailable", "render asset is unavailable") from exc
        if _sha256(payload) != content_digest:
            raise PackageSessionError("geometry_unavailable", "render asset failed digest verification")
        return payload


class SceneService:
    """Build revision-pinned semantic scenes from package sessions."""

    def __init__(
        self,
        sessions: PackageSessionService,
        assets: ContentAddressedAssetStore,
        geometry: GeometryAdapter | None = None,
    ) -> None:
        self._sessions = sessions
        self._assets = assets
        self._geometry = geometry or YapcadGeometryAdapter()

    def build_scene(
        self,
        session_id: str,
        *,
        at_revision: int,
        policy: TessellationPolicy = TessellationPolicy(),
    ) -> dict[str, Any]:
        source = self._sessions.get_render_source(session_id, at_revision=at_revision)
        if self._assets.root.is_relative_to(source.package_root):
            raise PackageSessionError(
                "permission_denied", "derived asset cache may not be stored inside a package",
            )
        snapshot = source.snapshot
        component_assets: dict[str, StoredAsset] = {}
        asset_records = []
        diagnostics = []
        generator_fingerprint = self._geometry.cache_fingerprint()
        for component in snapshot["components"]:
            geometry_digest = component.get("assetDigest")
            if not geometry_digest:
                diagnostics.append({
                    "code": "geometry_unavailable",
                    "message": f"component {component['id']} has no renderable geometry",
                    "entityIds": [component["id"]],
                })
                continue
            derivation = _derivation_digest(
                component["id"], geometry_digest, policy, generator_fingerprint,
            )
            asset = self._assets.find(derivation)
            if asset is None:
                mesh = self._geometry.component_mesh(source.package_root, component["id"], policy)
                payload = mesh_to_glb(mesh, component_id=component["id"])
                asset = self._assets.put(derivation, payload, mesh.source_representation)
            component_assets[component["id"]] = asset
            asset_records.append({
                "id": asset.content_digest,
                "componentId": component["id"],
                "mediaType": "model/gltf-binary",
                "byteLength": asset.byte_length,
                "sourceRepresentation": asset.source_representation,
                "derivationDigest": asset.derivation_digest,
                "generatorFingerprint": generator_fingerprint,
                "tessellation": policy.to_dict(),
            })

        nodes = []
        for part in snapshot["parts"]:
            asset = component_assets.get(part["componentId"])
            nodes.append({
                "id": part["id"],
                "name": part["name"],
                "componentId": part["componentId"],
                "parentId": part.get("parentId"),
                "materialId": part.get("materialId"),
                "assetId": asset.content_digest if asset else None,
                "transform": part["transform"],
                "visible": part["visible"],
            })
        scene = {
            "schema": SCENE_SCHEMA,
            "sessionId": snapshot["sessionId"],
            "revision": snapshot["revision"],
            "units": "millimetre",
            "assets": asset_records,
            "nodes": nodes,
            "diagnostics": diagnostics,
        }
        scene["digest"] = _sha256(_canonical_json(scene))
        return scene

    def read_asset(self, content_digest: str) -> bytes:
        return self._assets.read(content_digest)


class YapcadGeometryAdapter:
    """Tessellate authoritative BREP, falling back to packaged render meshes."""

    def cache_fingerprint(self) -> str:
        try:
            import yapcad
            try:
                import OCC
                occ_version = getattr(OCC, "VERSION", "unknown")
            except ImportError:
                occ_version = "unavailable"
        except ImportError:
            return "yapcad:unavailable;occ:unavailable"
        return f"yapcad:{getattr(yapcad, '__version__', 'unknown')};occ:{occ_version}"

    def component_mesh(
        self, package_root: Path, component_id: str, policy: TessellationPolicy,
    ) -> MeshData:
        try:
            from yapcad.brep import brep_from_solid, has_brep_data
            from yapcad.geom3d import issolid, issurface
            from yapcad.package import PackageManifest
        except ImportError as exc:
            raise PackageSessionError("geometry_unavailable", "compatible yapCAD is not installed") from exc
        try:
            entities = PackageManifest.load(package_root).load_component_geometry(component_id)
        except Exception as exc:
            raise PackageSessionError(
                "geometry_unavailable", f"failed to load geometry for {component_id}: {exc}",
            ) from exc
        surfaces: list[Any] = []
        used_brep = False
        for entity in entities:
            if issolid(entity):
                if has_brep_data(entity):
                    brep = brep_from_solid(entity)
                    if brep is None:
                        raise PackageSessionError(
                            "geometry_unavailable", f"failed to decode BREP for {component_id}",
                        )
                    try:
                        surface = brep.tessellate(
                            policy.linear_deflection_mm,
                            angular_deflection=policy.angular_deflection_rad,
                        )
                    except TypeError as exc:
                        raise PackageSessionError(
                            "geometry_unavailable",
                            "installed yapCAD does not support explicit angular tessellation",
                        ) from exc
                    except Exception as exc:
                        raise PackageSessionError(
                            "geometry_unavailable", f"BREP tessellation failed for {component_id}: {exc}",
                        ) from exc
                    surfaces.append(surface)
                    used_brep = True
                else:
                    _collect_surfaces(entity[1:], surfaces, issurface)
            elif issurface(entity):
                surfaces.append(entity)
        if not surfaces:
            raise PackageSessionError("geometry_unavailable", f"component {component_id} has no mesh")
        return _combine_surfaces(surfaces, "brep" if used_brep else "embedded-mesh")


def _collect_surfaces(value: Any, result: list[Any], is_surface: Any) -> None:
    if is_surface(value):
        result.append(value)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _collect_surfaces(item, result, is_surface)


def mesh_to_glb(mesh: MeshData, *, component_id: str) -> bytes:
    """Encode one deterministic indexed mesh as glTF 2.0 binary."""
    position_blob = b"".join(struct.pack("<3f", *point) for point in mesh.positions)
    normal_blob = b"".join(struct.pack("<3f", *normal) for normal in mesh.normals)
    index_blob = b"".join(struct.pack("<3I", *triangle) for triangle in mesh.triangles)
    binary = position_blob + normal_blob + index_blob
    position_offset = 0
    normal_offset = len(position_blob)
    index_offset = normal_offset + len(normal_blob)
    minima = [min(point[axis] for point in mesh.positions) for axis in range(3)]
    maxima = [max(point[axis] for point in mesh.positions) for axis in range(3)]
    document = {
        "asset": {"version": "2.0", "generator": EXPORTER_VERSION},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": component_id, "mesh": 0, "extras": {"componentId": component_id}}],
        "meshes": [{"name": component_id, "primitives": [{
            "attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "mode": 4,
        }]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": position_offset, "byteLength": len(position_blob), "target": 34962},
            {"buffer": 0, "byteOffset": normal_offset, "byteLength": len(normal_blob), "target": 34962},
            {"buffer": 0, "byteOffset": index_offset, "byteLength": len(index_blob), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(mesh.positions), "type": "VEC3", "min": minima, "max": maxima},
            {"bufferView": 1, "componentType": 5126, "count": len(mesh.normals), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5125, "count": len(mesh.triangles) * 3, "type": "SCALAR"},
        ],
        "extras": {"units": "millimetre", "sourceRepresentation": mesh.source_representation},
    }
    json_chunk = _pad(_canonical_json(document), b" ")
    binary_chunk = _pad(binary, b"\0")
    total_length = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
    return (
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk
        + struct.pack("<I4s", len(binary_chunk), b"BIN\0") + binary_chunk
    )


def _combine_surfaces(surfaces: Sequence[Any], representation: str) -> MeshData:
    positions: list[tuple[float, float, float]] = []
    normals: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []
    for surface in surfaces:
        vertices = surface[1]
        surface_normals = surface[2]
        faces = surface[3]
        offset = len(positions)
        positions.extend(tuple(float(value) for value in vertex[:3]) for vertex in vertices)
        if len(surface_normals) == len(vertices):
            normals.extend(tuple(float(value) for value in normal[:3]) for normal in surface_normals)
        else:
            normals.extend(_vertex_normals(vertices, faces))
        triangles.extend(tuple(int(index) + offset for index in face[:3]) for face in faces)
    return MeshData(tuple(positions), tuple(normals), tuple(triangles), representation)


def _vertex_normals(vertices: Sequence[Any], faces: Sequence[Any]) -> list[tuple[float, float, float]]:
    accumulated = [[0.0, 0.0, 0.0] for _ in vertices]
    for face in faces:
        a, b, c = (vertices[int(index)] for index in face[:3])
        ab = [b[index] - a[index] for index in range(3)]
        ac = [c[index] - a[index] for index in range(3)]
        normal = [ab[1] * ac[2] - ab[2] * ac[1],
                  ab[2] * ac[0] - ab[0] * ac[2],
                  ab[0] * ac[1] - ab[1] * ac[0]]
        for vertex_index in face[:3]:
            for axis in range(3):
                accumulated[int(vertex_index)][axis] += normal[axis]
    result = []
    for normal in accumulated:
        length = math.sqrt(sum(value * value for value in normal))
        result.append(tuple(value / length for value in normal) if length else (0.0, 0.0, 1.0))
    return result


def _derivation_digest(
    component_id: str,
    geometry_digest: str,
    policy: TessellationPolicy,
    generator_fingerprint: str,
) -> str:
    return _sha256(_canonical_json({
        "componentId": component_id,
        "geometryDigest": geometry_digest,
        "tessellation": policy.to_dict(),
        "exporter": EXPORTER_VERSION,
        "generatorFingerprint": generator_fingerprint,
    }))


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256(payload: bytes) -> str:
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _hex_digest(digest: str) -> str:
    algorithm, separator, value = digest.partition(":")
    if algorithm != "sha256" or not separator or len(value) != 64:
        raise ValueError("expected a sha256 digest")
    int(value, 16)
    return value


def _pad(payload: bytes, byte: bytes) -> bytes:
    return payload + byte * ((-len(payload)) % 4)


def _glb_source_representation(payload: bytes) -> str:
    if len(payload) < 20:
        raise ValueError("truncated GLB")
    magic, version, total_length = struct.unpack_from("<4sII", payload)
    json_length, chunk_type = struct.unpack_from("<I4s", payload, 12)
    if magic != b"glTF" or version != 2 or total_length != len(payload) or chunk_type != b"JSON":
        raise ValueError("invalid GLB header")
    end = 20 + json_length
    if end > len(payload):
        raise ValueError("truncated GLB JSON")
    try:
        document = json.loads(payload[20:end].decode("utf-8"))
        representation = document["extras"]["sourceRepresentation"]
    except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("GLB has no source representation") from exc
    if representation not in {"brep", "embedded-mesh"}:
        raise ValueError("invalid GLB source representation")
    return representation


def _atomic_write(path: Path, payload: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp",
    )
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
