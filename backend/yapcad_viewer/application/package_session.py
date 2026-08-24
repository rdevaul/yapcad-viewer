"""Read-only package-session lifecycle and semantic snapshot mapping."""

from __future__ import annotations

import copy
import hashlib
import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence
from uuid import UUID, uuid4


SESSION_SCHEMA = "yapcad-viewer-session-v1"
PRODUCT_PACKAGE_SCHEMA = "ycpkg-spec-v0.2"


class PackageSessionError(RuntimeError):
    """Stable application error suitable for transport adapters."""

    def __init__(
        self, code: str, message: str, *, diagnostics: Sequence[Mapping[str, Any]] = (),
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.diagnostics = [dict(item) for item in diagnostics]

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.diagnostics:
            result["diagnostics"] = copy.deepcopy(self.diagnostics)
        return result


@dataclass(frozen=True)
class PackageSourcePolicy:
    """Constrain local package access before yapCAD parses any content."""

    allowed_roots: tuple[Path, ...]
    max_package_bytes: int = 2 * 1024 * 1024 * 1024
    max_files: int = 20_000
    require_ycpkg_suffix: bool = True

    def __post_init__(self) -> None:
        if not self.allowed_roots:
            raise ValueError("at least one allowed package root is required")
        if self.max_package_bytes <= 0 or self.max_files <= 0:
            raise ValueError("package size and file limits must be positive")

    def authorize(self, source: Path | str) -> Path:
        requested = Path(source).expanduser()
        if requested.is_symlink():
            raise PackageSessionError("permission_denied", "package path may not be a symlink")
        try:
            package_root = requested.resolve(strict=True)
        except FileNotFoundError as exc:
            raise PackageSessionError("invalid_package", f"package does not exist: {requested}") from exc
        roots = tuple(root.expanduser().resolve(strict=True) for root in self.allowed_roots)
        if not any(package_root.is_relative_to(root) for root in roots):
            raise PackageSessionError(
                "permission_denied", f"package is outside configured roots: {package_root}",
            )
        if not package_root.is_dir():
            raise PackageSessionError(
                "unsupported_schema",
                "archive .ycpkg sources are not supported yet; provide an unpacked package directory",
            )
        if self.require_ycpkg_suffix and package_root.suffix != ".ycpkg":
            raise PackageSessionError("invalid_package", "package directory must end in .ycpkg")
        self._check_members(package_root)
        return package_root

    def _check_members(self, package_root: Path) -> None:
        total_bytes = 0
        file_count = 0
        for member in package_root.rglob("*"):
            if member.is_symlink():
                raise PackageSessionError(
                    "permission_denied", f"package contains a symlink: {member.relative_to(package_root)}",
                )
            resolved = member.resolve(strict=True)
            if not resolved.is_relative_to(package_root):
                raise PackageSessionError("permission_denied", "package member escapes package root")
            if resolved.is_file():
                file_count += 1
                total_bytes += resolved.stat().st_size
                if file_count > self.max_files:
                    raise PackageSessionError("invalid_package", "package contains too many files")
                if total_bytes > self.max_package_bytes:
                    raise PackageSessionError("invalid_package", "package exceeds configured size limit")


class PackageAdapter(Protocol):
    def load(self, package_root: Path, *, strict: bool) -> "LoadedProductPackage": ...


@dataclass(frozen=True)
class LoadedProductPackage:
    manifest: Mapping[str, Any]
    assembly: Mapping[str, Any]
    bom: Mapping[str, Any]
    valid: bool
    validation_messages: tuple[str, ...]


class YapcadPackageAdapter:
    """Thin authority adapter around yapCAD's package implementation."""

    def load(self, package_root: Path, *, strict: bool) -> LoadedProductPackage:
        try:
            from yapcad.package import PackageManifest, validate_package
        except ImportError as exc:
            raise PackageSessionError(
                "unsupported_schema",
                "yapCAD 1.1 or newer is required to open product-definition packages",
            ) from exc

        valid, messages = validate_package(package_root, strict=strict)
        try:
            manifest = PackageManifest.load(package_root)
        except Exception as exc:
            raise PackageSessionError("invalid_package", f"failed to load package manifest: {exc}") from exc
        schema = manifest.data.get("schema")
        if schema != PRODUCT_PACKAGE_SCHEMA:
            raise PackageSessionError(
                "unsupported_schema",
                f"read-only sessions currently require {PRODUCT_PACKAGE_SCHEMA}; found {schema!r}",
            )
        if not valid:
            diagnostics = [_diagnostic(message) for message in messages if _severity(message) == "error"]
            raise PackageSessionError(
                "validation_failed", "package failed yapCAD validation", diagnostics=diagnostics,
            )
        return LoadedProductPackage(
            manifest=copy.deepcopy(manifest.data),
            assembly=copy.deepcopy(manifest.load_assembly_record()),
            bom=copy.deepcopy(manifest.load_bom()),
            valid=True,
            validation_messages=tuple(messages),
        )


@dataclass
class _PackageSession:
    session_id: UUID
    package_root: Path
    snapshot: dict[str, Any]


class PackageSessionService:
    """Own open read-only package sessions without exposing mutable internals."""

    def __init__(self, policy: PackageSourcePolicy, adapter: PackageAdapter | None = None) -> None:
        self._policy = policy
        self._adapter = adapter or YapcadPackageAdapter()
        self._sessions: dict[UUID, _PackageSession] = {}

    def open_package(self, source: Path | str, *, strict: bool = True) -> dict[str, Any]:
        package_root = self._policy.authorize(source)
        digest_before = _package_digest(package_root)
        loaded = self._adapter.load(package_root, strict=strict)
        digest_after = _package_digest(package_root)
        if digest_before != digest_after:
            raise PackageSessionError("invalid_package", "package changed while it was being opened")
        session_id = uuid4()
        snapshot = _build_snapshot(session_id, package_root, digest_after, loaded)
        self._sessions[session_id] = _PackageSession(session_id, package_root, snapshot)
        return copy.deepcopy(snapshot)

    def get_snapshot(self, session_id: UUID | str) -> dict[str, Any]:
        session = self._get(session_id)
        return copy.deepcopy(session.snapshot)

    def close_session(self, session_id: UUID | str, *, expected_revision: int = 0) -> None:
        session = self._get(session_id)
        if expected_revision != session.snapshot["revision"]:
            raise PackageSessionError(
                "revision_conflict",
                f"expected revision {expected_revision}, current revision is {session.snapshot['revision']}",
            )
        del self._sessions[session.session_id]

    def _get(self, session_id: UUID | str) -> _PackageSession:
        try:
            key = session_id if isinstance(session_id, UUID) else UUID(str(session_id))
        except (TypeError, ValueError) as exc:
            raise PackageSessionError("unknown_session", f"invalid session ID: {session_id}") from exc
        try:
            return self._sessions[key]
        except KeyError as exc:
            raise PackageSessionError("unknown_session", f"session is not open: {key}") from exc


def _build_snapshot(
    session_id: UUID, package_root: Path, package_digest: str, loaded: LoadedProductPackage,
) -> dict[str, Any]:
    manifest = loaded.manifest
    assembly = loaded.assembly
    components_by_id = {item["id"]: item for item in manifest.get("components", [])}
    root_part = assembly.get("rootPart") or (manifest.get("assembly") or {}).get("rootPart")
    parents = _derive_parents(root_part, assembly.get("parts", {}), assembly.get("mates", []))

    components = [_component_snapshot(item) for item in manifest.get("components", [])]
    parts = []
    instance_by_id = {item["id"]: item for item in manifest.get("instances", [])}
    for part_id, part_record in assembly.get("parts", {}).items():
        component_id = part_record.get("component") or instance_by_id.get(part_id, {}).get("component")
        component = components_by_id.get(component_id, {})
        transform = part_record.get("transform") or instance_by_id.get(part_id, {}).get("transform")
        parts.append({
            "id": part_id,
            "name": part_id.replace("_", " ").replace("-", " ").capitalize(),
            "componentId": component_id,
            "parentId": parents.get(part_id),
            "materialId": component.get("material"),
            "assetDigest": _digest_field((component.get("geometry") or {}).get("hash")),
            "transform": _column_major_matrix(transform),
            "datums": copy.deepcopy(part_record.get("datums", [])),
            "visible": True,
        })

    mates = [_mate_snapshot(item) for item in assembly.get("mates", [])]
    joint_values = assembly.get("jointValues", {})
    joints = []
    for mate in assembly.get("mates", []):
        kind = mate.get("kind")
        if mate.get("id") not in joint_values and kind not in {"revolute", "prismatic"}:
            continue
        limits = mate.get("limits") or {}
        joints.append({
            "id": mate["id"],
            "kind": kind,
            "value": float(joint_values.get(mate["id"], 0.0)),
            "unit": "millimetre" if kind == "prismatic" else "radian",
            "minimum": limits.get("min_value"),
            "maximum": limits.get("max_value"),
        })

    warnings = [
        _diagnostic(message) for message in loaded.validation_messages
        if _severity(message) == "warning"
    ]
    return {
        "schema": SESSION_SCHEMA,
        "sessionId": str(session_id),
        "revision": 0,
        "package": {
            "name": manifest.get("name") or package_root.stem,
            "version": str(manifest.get("version") or "0"),
            "digest": package_digest,
            "rootPartId": root_part,
        },
        "components": components,
        "parts": parts,
        "mates": mates,
        "joints": joints,
        "bom": {"items": [_bom_item(item) for item in loaded.bom.get("items", [])]},
        "materials": copy.deepcopy(manifest.get("materials", {})),
        "selection": [],
        "validation": {"valid": loaded.valid, "errors": [], "warnings": warnings},
    }


def _component_snapshot(component: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": component["id"],
        "name": component.get("name") or component["id"],
        "description": component.get("description"),
        "disposition": component["disposition"],
        "quantityPerInstance": component.get("quantityPerInstance", 1),
        "unit": component.get("unit", "each"),
        "partNumber": component.get("partNumber"),
        "revision": component.get("revision"),
        "materialId": component.get("material"),
        "manufacturing": copy.deepcopy(component.get("manufacturing")),
        "procurement": copy.deepcopy(component.get("procurement")),
        "pmi": copy.deepcopy(component.get("pmi")),
        "assetDigest": _digest_field((component.get("geometry") or {}).get("hash")),
    }


def _mate_snapshot(mate: Mapping[str, Any]) -> dict[str, Any]:
    result = {
        key: mate[key] for key in ("id", "kind", "partA", "datumA", "partB", "datumB")
    }
    result["offset"] = float(mate.get("offset", 0.0))
    result["angle"] = float(mate.get("angle", 0.0))
    result["limits"] = copy.deepcopy(mate.get("limits"))
    return result


def _bom_item(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "item": int(item["item"]),
        "componentId": item["component"],
        "partNumber": item.get("partNumber"),
        "revision": item.get("revision"),
        "description": item.get("description", ""),
        "disposition": item["disposition"],
        "quantity": item["quantity"],
        "unit": item["unit"],
    }


def _derive_parents(
    root_part: str | None, parts: Mapping[str, Any], mates: Sequence[Mapping[str, Any]],
) -> dict[str, str | None]:
    parents: dict[str, str | None] = {part_id: None for part_id in parts}
    if root_part not in parts:
        return parents
    adjacency: dict[str, list[str]] = {part_id: [] for part_id in parts}
    for mate in mates:
        a, b = mate.get("partA"), mate.get("partB")
        if a in adjacency and b in adjacency:
            adjacency[a].append(b)
            adjacency[b].append(a)
    seen = {root_part}
    queue = deque([root_part])
    while queue:
        parent = queue.popleft()
        for child in adjacency[parent]:
            if child not in seen:
                seen.add(child)
                parents[child] = parent
                queue.append(child)
    return parents


def _column_major_matrix(matrix: Any) -> list[float]:
    if not (
        isinstance(matrix, list) and len(matrix) == 4
        and all(isinstance(row, list) and len(row) == 4 for row in matrix)
    ):
        raise PackageSessionError("invalid_package", "part has no valid solved 4x4 transform")
    values = [float(matrix[row][column]) for column in range(4) for row in range(4)]
    if not all(math.isfinite(value) for value in values):
        raise PackageSessionError("invalid_package", "part transform contains a non-finite value")
    return values


def _package_digest(package_root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in package_root.rglob("*") if item.is_file()):
        relative = path.relative_to(package_root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _digest_field(value: Any) -> str | None:
    if not value:
        return None
    text = str(value).lower()
    return text if text.startswith("sha256:") else f"sha256:{text}"


def _severity(message: str) -> str:
    prefix = message.partition(":")[0].strip().lower()
    if prefix in {"error", "failed"}:
        return "error"
    if prefix == "warning":
        return "warning"
    return "info"


def _diagnostic(message: str) -> dict[str, Any]:
    severity = _severity(message)
    body = message.partition(":")[2].strip() or message
    return {"code": f"package_{severity}", "message": body, "entityIds": []}
