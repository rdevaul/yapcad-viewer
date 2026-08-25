# yapcad-viewer architecture

Status: proposed contract baseline, 2026-08-23

## Decision

`yapcad-viewer` will be a standalone application that depends on yapCAD as an
engineering kernel. It will expose a stateful package-session service through
REST and WebSocket transports and, separately, through an MCP adapter. The web
viewer, MCP clients, command-line clients, and test harnesses will all invoke
the same application commands.

The viewer will not contain an agent runtime, chat provider, prompt harness,
or model-specific orchestration. Those systems evolve independently and are
clients of the viewer.

## Context

yapCAD currently contains three overlapping viewer generations:

1. `src/yapcad/package/viewer.py`, a Pyglet `.ycpkg` viewer that combines
   package loading, BREP tessellation, drawing, and interaction.
2. `src/yapcad/viewer/`, a VTK viewer with a Flask/SocketIO control server.
3. `service/` and the historical `feature/workbench-v2` branch, which contain
   a FastAPI service and React/Three.js workbench.

The historical workbench demonstrates valuable interaction patterns, but it
also couples the viewer to a particular chat session, skills UI, file editor,
and agent harness. Its branch has no common merge base with current yapCAD
main, and its service targets `yapcad-geometry-json-v0.1`. It is therefore a
source of components and lessons, not the new repository history.

## Goals

- Open and validate `.ycpkg` files, including assembly product definitions.
- Preserve analytic `yapcad-geometry-json-v0.2` BREP as authoritative data.
- Present a semantic product tree linked to renderable scene nodes.
- Inspect BOM, materials, datums, mates, joint limits, and validation results.
- Select, isolate, hide, highlight, section, explode, measure, and pose parts.
- Produce deterministic screenshots and machine-readable measurements.
- Make the same capabilities available through REST, WebSocket, and MCP.
- Support local-first operation without requiring a cloud service.
- Make every mutation revision-checked, evented, and auditable.

## Non-goals for v1

- Embedded chat, prompt management, or model-provider integration.
- General-purpose agent orchestration or autonomous design loops.
- Collaborative text editing, CRDTs, or source-control automation.
- Full DSL authoring and IDE behavior.
- Modifying the authoritative BREP through browser-side mesh operations.
- Treating screenshots or tessellated meshes as engineering truth.

## System boundaries

```text
                         +----------------------+
                         | Human web client     |
                         | React + Three.js     |
                         +----------+-----------+
                                    | REST / WebSocket
                                    v
+-------------+          +----------+-----------+          +-------------+
| MCP client  +--------->+ PackageSession       +<---------+ CLI/scripts |
| any runtime |   MCP    | application service  |   REST   |             |
+-------------+          +----------+-----------+          +-------------+
                                    |
                                    | public Python APIs
                                    v
                         +----------+-----------+
                         | yapCAD kernel        |
                         | package/BREP/mates   |
                         +----------------------+
```

### yapCAD owns

- Package parsing, schema validation, signing, and manufacturing exports.
- Geometry JSON v0.2 encoding and authoritative analytic BREP handling.
- Tessellation, assembly solving, collision, and validation algorithms.
- Stable semantic identifiers stored in package data.

### yapcad-viewer owns

- Session lifecycle and optimistic concurrency.
- Render-scene construction and mesh caching.
- Human interaction state: selection, visibility, camera, section planes.
- Pose requests and presentation of engineering results.
- REST, WebSocket, and MCP adapters.
- The browser application and viewer-specific deployment.

Generic kernel capabilities discovered during implementation should be added
to yapCAD through focused upstream changes. Application state and transport
concerns stay here.

## Package session model

A `PackageSession` is the sole mutable aggregate in v1. It contains:

- A verified package identity and SHA-256 content digest.
- The package manifest, product tree, BOM, material references, and analyses.
- Stable part-instance IDs and their current transforms.
- Joint values and solver diagnostics.
- Current visibility, selection, highlighting, section, and view state.
- Derived mesh assets keyed by geometry digest and tessellation parameters.
- A monotonically increasing integer revision.

The session snapshot preserves product semantics as distinct collections:
component definitions describe make/buy/raw-stock/consumable identity, parts
describe positioned instances and their datums, mates preserve assembly
constraints, joints expose poseable scalar values, and the BOM retains its
component references. Transform arrays are column-major homogeneous 4x4
matrices so they can be consumed directly by the Three.js client.

The first implementation accepts unpacked `.ycpkg` directories using
`ycpkg-spec-v0.2`. Archive ingestion and legacy v0.1 flattening are explicit
later compatibility tasks; neither is guessed at during package opening.

Every state-changing command carries `expectedRevision`. A command succeeds
only when it matches the current session revision. Success increments the
revision exactly once and publishes an event containing the command ID and
new revision. A mismatch returns a conflict with the latest snapshot. This
prevents a human and agent from silently overwriting each other's state.

Opening a package is conceptually immutable. If authoritative package content
changes, the service opens a new package revision or explicitly reloads it;
presentation state changes do not rewrite the `.ycpkg` file.

## Scene and geometry pipeline

1. The backend opens and validates the package using yapCAD.
2. Geometry JSON v0.2 and embedded BREP remain server-side and authoritative.
3. The backend resolves product instances and applies assembly transforms.
4. OCC tessellates BREP using explicit linear and angular deflection values.
5. A content-addressed cache stores derived GLB assets.
6. The scene snapshot references those assets and maps every primitive back to
   stable part, component, material, and geometry IDs.
7. Three.js renders GLB assets and never performs engineering booleans.

The browser also provides an explicit local-preview adapter for unpacked v0.2
packages selected by the user. It maps the manifest and semantic metadata to
the same session/scene contracts and converts the already-embedded display
triangles to in-memory GLB assets. It neither decodes nor validates the BREP,
and marks this limitation in session diagnostics. Authoritative validation,
BREP tessellation, pose solving, and network sessions continue to cross the
Python application-service boundary described above.

GLB is the preferred 3D delivery format because it is compact, broadly
supported by Three.js, and can retain semantic IDs through node names and
`extras`. Geometry JSON remains available through explicit engineering APIs,
not as the normal browser payload. Two-dimensional sketches may be delivered
as a compact polyline document or SVG with the same semantic identity rules.

Mesh cache keys include:

- Authoritative geometry digest.
- Stable component ID and the local-component transform policy.
- Linear and angular tessellation tolerances.
- Viewer exporter version plus yapCAD and OCC versions.

The derivation digest covers those inputs and enables a cache lookup before
tessellation. The public asset ID is independently computed from the finished
GLB bytes. Instances of one component share an asset; their transforms remain
in the scene snapshot rather than being baked into duplicated meshes.

## Application commands

The initial revision-changing command contract includes:

- `set_selection`: replace, add, or remove stable part IDs.
- `set_visibility`: show or hide stable part IDs.
- `set_pose`: set named joint values and return solver diagnostics.
- `set_view`: set camera projection, position, target, and up vector.

Later commands may add section planes, exploded views, annotations, and
manufacturing exports. Commands are domain operations, not arbitrary Python or
viewer-method invocation.

Read-only operations use a separate query contract. Queries specify
`atRevision`, do not increment session revision, and can therefore be repeated
deterministically. Initial queries are `measure_distance` and
`request_render`; a render query returns a job when it cannot complete
synchronously.

## REST resources

The proposed v1 surface is intentionally small:

| Method | Resource | Purpose |
|---|---|---|
| `POST` | `/v1/sessions` | Upload or open an allowed package URI |
| `GET` | `/v1/sessions/{id}` | Retrieve the current semantic snapshot |
| `GET` | `/v1/sessions/{id}/scene` | Retrieve a revision-pinned derived scene |
| `DELETE` | `/v1/sessions/{id}` | Close a session and release caches |
| `POST` | `/v1/sessions/{id}/commands` | Execute a revision-checked command |
| `POST` | `/v1/sessions/{id}/queries` | Execute a read-only revision-pinned query |
| `GET` | `/v1/sessions/{id}/events` | Upgrade to a WebSocket event stream |
| `GET` | `/v1/assets/{digest}` | Retrieve an immutable GLB or image asset |
| `GET` | `/v1/jobs/{id}` | Inspect a long-running render/export job |
| `POST` | `/v1/jobs/{id}/cancel` | Request cooperative cancellation |

Package upload is the safe network default. Local file URIs are allowed only
for explicitly configured roots. Paths sent by an untrusted client are never
opened without policy validation.

## WebSocket events

Events are ordered within a session and include the resulting revision. The
initial event types are:

- `session.opened`
- `session.state_changed`
- `session.conflict`
- `job.started`
- `job.progress`
- `job.completed`
- `job.failed`
- `session.closed`

Clients that miss an event retrieve the current snapshot rather than trying
to replay an unbounded history. A bounded diagnostic event log may be retained
for debugging and agent traceability.

## MCP adapter

MCP is a transport adapter, not the implementation of viewer behavior. Each
tool invokes the same application command handlers as REST. The initial tool
set is:

- `viewer_open_package`
- `viewer_get_snapshot`
- `viewer_set_selection`
- `viewer_set_visibility`
- `viewer_set_pose`
- `viewer_measure_distance`
- `viewer_render`
- `viewer_close_session`

Inspection tools are read-only. Mutating tools require an expected revision.
Tool results return semantic IDs, revision numbers, structured diagnostics,
and resource links for generated images or GLB assets. Agents should not need
to infer part identity from pixels.

The MCP server can run over stdio for a local single-user process or connect
to an existing HTTP service. No model credentials are held by the viewer.

## Security and execution

- Bind to loopback by default; network exposure is explicit.
- Replace wildcard CORS with configured origins.
- Validate package size, member paths, decompression limits, and signatures.
- Reject archive traversal and symlink escapes.
- Restrict local package URIs and export destinations to allowed roots.
- Run DSL/OCC work in cancellable worker processes with time and memory limits.
- Do not expose generic filesystem, shell, Python, or git-commit endpoints.
- Keep read-only and mutating capabilities distinct in REST and MCP metadata.
- Record the package digest, command ID, client ID, and revision for mutations.

Authentication is deployment-specific. Local stdio MCP may rely on process
boundaries; network service deployments should use bearer tokens or a trusted
reverse proxy. Authentication does not belong in the geometry domain layer.

## Error model

Errors are structured and stable:

- `invalid_package`
- `unsupported_schema`
- `validation_failed`
- `revision_conflict`
- `unknown_part`
- `unknown_joint`
- `joint_limit_exceeded`
- `solve_failed`
- `geometry_unavailable`
- `job_failed`
- `permission_denied`

Responses include a human message, machine code, relevant semantic IDs, and
diagnostics. Geometry or solver failures must not be reduced to HTTP 500 with
an unstructured traceback.

## Repository layout

The implementation phase will grow toward:

```text
yapcad-viewer/
  backend/yapcad_viewer/
    application/       PackageSession and command handlers
    adapters/http/     FastAPI and WebSocket
    adapters/mcp/      MCP tool server
    rendering/         scene extraction, tessellation, GLB cache
  web/                 React + Three.js application
  contracts/           transport-independent JSON Schemas
  docs/                architecture and decisions
  tests/               contract and acceptance tests
```

The backend will depend on a pinned released yapCAD version. The frontend will
consume generated TypeScript types from the reviewed contracts rather than
maintaining hand-written duplicates.

## Migration strategy

1. Freeze and test the contract schemas in this repository.
2. Implement read-only `PackageSession` open/snapshot/close around yapCAD.
3. Use a YapRover `.ycpkg` as the primary assembly acceptance fixture.
4. Implement content-addressed tessellation and GLB scene delivery.
5. Extract the Three.js renderer, lighting, clipping, and layer controls from
   `feature/workbench-v2` behind the new contracts.
6. Add selection, visibility, camera, pose, measurement, and render commands.
7. Add the MCP adapter and prove UI/MCP state convergence.
8. Deprecate the old Pyglet package viewer and Flask/VTK API only after the new
   viewer meets compatibility acceptance criteria.

## YapRover acceptance scenario

The first meaningful integration fixture is a versioned YapRover prototype
package containing fabricated and COTS components, analytic BREP, a product
tree, BOM, datums, mates, joint limits, and validation results.

Acceptance requires that both a browser user and MCP client can:

1. Open and validate the same package digest.
2. Retrieve the same product tree and six-wheel assembly snapshot.
3. Select and isolate a rocker, bogie, wheel, chassis, or differential part.
4. Set a legal suspension pose and receive coincident-axis residuals.
5. Reject an out-of-range pose without changing the last valid revision.
6. Measure a named clearance using semantic targets.
7. Produce a deterministic isometric rendering with visible part IDs recorded.
8. Observe each other's state changes through the event stream.

## Versioning

- HTTP resources begin at `/v1`.
- JSON documents carry explicit schema identifiers.
- Additive fields are allowed within a major version.
- Removing fields, changing units, or changing command meaning requires a new
  major contract version.
- Units are explicit; the initial mechanical contract uses millimetres and
  radians.

## Open decisions

- Whether GLB is returned as one assembly asset or per-component assets for
  very large packages.
- Whether presentation state should optionally be exportable as a separate,
  non-authoritative review artifact.
- The exact semantic target syntax for face/edge measurements once stable
  topological naming is available.
- Whether the MCP adapter ships in the same Python distribution or as an
  optional extra; it remains in this repository either way.
