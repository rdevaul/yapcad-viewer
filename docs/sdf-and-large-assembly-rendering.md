# SDF and large-assembly rendering

Status: proposed, 2026-10-01; revised 2026-10-16 with measured meshing
costs (see Context and problem statement 3).

## Decision

The viewer will render through three tiers instead of one, and will compose
them in a single frame:

| Tier | Source | Used for | Fidelity |
|---|---|---|---|
| **Mesh** | GLB from BREP or embedded mesh (today's path) | Geometry of interest from BREP, STL or STEP | Tessellation tolerance |
| **Field** | Ray-marched SDF tree, or a sampled distance grid | Geometry of interest authored as SDF | Exact (tree) or voxel-limited (grid) |
| **Splat** | Oriented Gaussian surfels generated from any source | Context: the rest of a very large assembly | Display only, screen-space accurate |

The **hybrid mode** draws a *focus set* (selected, isolated, sectioned or
nearby parts) through the mesh or field tier and the *context set* (everything
else) as splats. Splats make memory scale with screen resolution and level of
detail rather than with assembly size. They are the only tier that can show a
whole launch-vehicle assembly — on the order of 10^5–10^6 part instances — on
one GPU.

Every tier is a display derivative. Measurements, validation and engineering
queries stay on the backend against authoritative geometry, as
`architecture.md` already requires.

## Context

Facts about the current viewer:

- `web/src/viewer/SceneViewer.ts` uses three.js `WebGLRenderer`. `load()`
  fetches and parses *every* scene asset before the first frame, then clones a
  template per scene node.
- Section planes are renderer clipping planes. Picking is `Raycaster` against
  meshes. Render modes are solid, wireframe and x-ray.
- `contracts/scene-v1.schema.json` allows an asset's `sourceRepresentation` to
  be only `"brep"` or `"embedded-mesh"`, and requires tessellation tolerances on
  every asset.
- The browser loader reads `yapcad-geometry-json-v0.2` and v0.3 (#8). v0.3
  adds `"sdf"` as an authoritative representation, with the node tree in
  `representations.sdf`. Nothing in the viewer reads that record yet, so an
  SDF-authoritative part renders today only if it also ships a preview mesh.
- Mesh transport in yapCAD now keeps small faces, dropping only exactly
  degenerate ones (yapCAD #86), and simplification no longer emits slivers
  (yapCAD #83). Degeneracy is still judged against an absolute epsilon, so it
  depends on the units a part is modelled in, and transport and the geometric
  predicates deliberately disagree about it (yapCAD #85, open). Anything here
  that reasons about what a preview mesh contains should read that issue
  first.
- `docs/sdf-meshing-and-simplifier-performance.md` in yapCAD is the companion
  to this note: it covers where meshing and simplification spend their time
  and the feature-size responsive dual contouring that would fix the uniform
  grid, where this one covers rendering the field without meshing it at all.

Facts about yapCAD's SDF package (`yapcad.sdf`) that this design relies on:

- A field is an immutable, digest-addressed node DAG — about 20 node kinds:
  analytic primitives, hard and smooth booleans, offset, shell, affine
  transforms, gyroid and Schwarz-P lattices. It serializes with
  `tree_to_json`.
- `analyze(node)` reports, per node, bounds, whether the field is an exact
  distance, and a Lipschitz bound *L* (how fast the value can change). A ray
  can always advance by `d / L` without passing through the surface.
- Backends register per node kind (`register_backend(kind, name, fn)`). The
  numpy evaluator is the reference.

The problem has three parts, the third of which was measured after this
design was first written:

1. **SDF parts should not need tessellation to be seen.** Meshing an SDF is the
   slowest step in its pipeline and loses detail. Lattices are the worst case:
   millions of triangles for a pattern a shader evaluates in a few
   instructions.
2. **Very large assemblies do not fit.** A full vehicle assembly tessellated
   for inspection is plausibly 10^8–10^9 triangles. At roughly 20–30 bytes per
   triangle with indexed positions and normals, that is tens of gigabytes —
   beyond any GPU, and beyond what `load()`'s fetch-everything approach can
   transfer.
3. **Small parts with fine features are not meshable at interactive rates
   either, and are not yet meshable correctly at all.** This is not only a
   problem of scale. A 70 x 30 x 4 mm plate with three lines of 3 mm engraved
   block text — a field of a slab minus 212 stroke boxes — took 674 seconds to
   mesh and simplify, and yapCAD's recent union culling and batch
   consolidation have that at 147 seconds. The raw mesh is 227,512 triangles
   for a part whose simplified form is 8,784, and it still carries 62 boundary
   edges, because a uniform grid must be fine enough everywhere for the
   smallest feature anywhere, and even at 326^3 cells a 0.43 mm stroke gets
   only two 0.215 mm cells across it — thin enough that the surface begins
   passing through single cells twice (yapCAD #94). Raising the resolution
   does not escape it: at 490^3 the same plate fails outright with 165
   coincident vertices. There is no resolution at which that plate meshes
   cleanly.

   A raymarched preview needs none of it. This is the argument that separates
   the two jobs: **a preview is a picture, and a picture need not be
   watertight.** Meshing exists to feed manufacturing, where correctness
   matters and latency does not; rendering wants the opposite trade, and
   trying to serve both from one tessellation is what makes engraved lettering
   look like an intractable problem rather than a shader.

## Goals

- Render SDF-authoritative parts directly from their field, at any zoom, with
  sharp edges and no tessellation.
- Show an entire very large assembly interactively, within a fixed GPU memory
  budget, with correct part identity on every pixel.
- Let the user (or an agent) move any part between focus and context without
  reloading the scene.
- Keep the semantic guarantees the viewer already makes: stable part IDs,
  revision-pinned scenes, content-addressed assets.

## Non-goals

- Photogrammetric Gaussian splatting (training splats from photographs).
  Splats here are *generated* from geometry, deterministically.
- Treating any tier's pixels as engineering truth.
- Editing geometry in the browser. Live parameter edits of an SDF tree are an
  open question (see below), not a v1 goal.

## Hybrid rendering mode

### Focus and context

A **focus set** is a set of part-instance IDs. A part is in focus when any of
these holds:

- it is selected or isolated;
- a section plane cuts it;
- the user pinned it;
- it is within a camera-distance or screen-size threshold *and* the GPU
  budget allows it (automatic promotion).

Everything else visible is **context** and draws as splats. Focus membership
is presentation state and belongs to the session like selection and
visibility, so an MCP client and a browser converge on the same view. It
would be one new revision-checked command (`set_focus`), with automatic
promotion computed client-side and never written to the session.

### Frame composition

1. **Opaque focus pass.** Mesh-tier parts draw as today. Field-tier parts draw
   as proxy boxes whose fragment shader ray-marches the field and writes
   `gl_FragDepth`. Both fill the shared depth buffer, so they occlude each
   other correctly.
2. **Context pass.** Splats are depth-tested against that buffer. A splat whose
   part ID is in the focus set is discarded, via a per-instance visibility
   bitmask texture, so no part draws twice.
3. **ID pass (on demand).** Part IDs render to an integer target for picking
   and for agent queries ("which part is at this pixel"), so agents never have
   to infer identity from color.

CAD context is opaque, so the splat pass need not use sorted alpha blending.
Two-pass surface splatting (a depth-only visibility pass, then an
accumulation pass that blends only splats within a depth band of the front
surface, then normalization) gives smooth, hole-free surfaces with no
per-frame sort. Sorted alpha blending stays available for x-ray mode.

### Memory budget

A **budget manager** owns GPU memory across tiers:

- the context tier gets a fixed allotment, e.g. 256–512 MB, and streams splat
  LOD nodes in and out of it by screen-space error;
- the focus tier gets the rest, and automatic promotion stops when it is
  full;
- assets load on demand, replacing `load()`'s fetch-everything step.

The estimate that makes this work: on-screen splat count is bounded by
pixels, not by part count. A 4K frame has about 8.3 M pixels. A resident set
of 10–30 M splats at about 16 bytes each is 160–480 MB, whether the assembly
has a thousand parts or a million.

## Field tier: ray-marching SDFs

### Shader generation

The viewer, in TypeScript, compiles the JSON tree into a GLSL function
`float map(vec3 p)`. The contract therefore carries data, not code, and the
browser never runs shader source supplied by a server. Each node kind maps to
a GLSL snippet with its parameters folded in as constants.

Two strategies, to pick between by measurement:

- **Compiled shader per tree:** fastest per frame, but every tree change costs
  a shader compile, roughly 50–500 ms.
- **Fixed interpreter:** one shader walks the tree from a data texture (a
  "tape" of operations). Slower per frame, but there is no compile, and a
  parameter change is a texture update.

Start compiled, and add the interpreter if live parameter edits become a
goal.

### Correctness

There are now two evaluators: yapCAD's numpy reference and the generated
GLSL. yapCAD will publish a **conformance fixture**: test trees covering every
node kind, with sample points and their reference distances. The viewer's CI
evaluates the same points through its generator (headless WebGL, or a
TypeScript port of the snippets) and compares within a stated tolerance.
Adding a node kind to yapCAD without its GLSL snippet fails the fixture, not
a user's render.

### Ray marching

- Each field instance draws as a proxy box of its `analyze` bounds, in the
  component's local frame. Marching in local coordinates keeps 32-bit floats
  accurate at millimetre scale anywhere in a large assembly.
- The step is `d / L`, using the Lipschitz bound. Exact fields march at full
  step; smooth booleans, lattices and non-uniform scales march safely at
  reduced step.
- Normals come from a four-sample tetrahedral gradient.
- Subtree culling: skip a subtree whenever the ray is farther from its bounds
  than the current best distance. This is the main defence against large
  trees.
- Progressive quality: lower resolution and step budget while the camera
  moves, refined when it stops.

### Interaction

- **Sections.** A clipping plane becomes a half-space intersected inside
  `map()`. The result is a capped, solid cut, which mesh clipping cannot give
  (clipped meshes look hollow). Caps can be tinted, or contour-lined by
  distance.
- **Picking.** Hit the proxy box, then confirm with a CPU march (a small
  TypeScript evaluator) or read the ID pass.
- **X-ray.** Accumulate along the ray.
- **Wireframe.** Undefined without triangles. Offer screen-space feature
  edges (normal and depth discontinuities) and iso-distance contours on
  section planes instead.

### Sampled grids

For trees too expensive to evaluate per pixel, and for imported or measured
fields, the same marcher reads a 3D texture instead of `map()`. This matches
yapCAD's planned sampled-grid node and its stdlib-readable `.npy` subset
(v1.0, little-endian `<f4`, C order). A dense 256³ grid at 16 bits is about
32 MB, and detail finer than a voxel is lost. Sparse brick storage (voxels
only near the surface) is the follow-on, and is much easier under WebGPU.

## Splat tier: context for very large assemblies

### Why splats here

Mesh decimation is the obvious alternative for context, and it remains the
right tool for large, simple parts. It degrades worst on exactly what fills a
vehicle: fasteners, brackets, harnesses, tubing and lattices. These have thin
features and topology that simplification either keeps (no savings) or
destroys (holes, popping). That is now measured rather than asserted: the
engraved plate in problem statement 3 spends 97% of its pipeline in
simplification, and the simplified result still has 62 boundary edges. The
parts that fill a vehicle are the parts decimation handles worst. Splat
generation, by contrast, is uniform for every source representation and every
shape. A coarser level of detail is computed by
fitting one Gaussian to a group of children, so the hierarchy needs no mesh
topology at all.

### Splat format

Use **2D (oriented-disk) Gaussians**, not volumetric 3D Gaussians. A 2D
Gaussian has a well-defined normal and ray-intersection depth. That makes it
shadeable with the same lights as the focus tiers, depth-testable against
them, and pickable.

Each splat stores (estimated at about 16 bytes):

- position, quantized relative to its LOD node bounds;
- a normal, octahedral-encoded;
- two tangent-plane scales;
- a material index;
- a part-instance index.

Lighting is applied at render time from the normal and material. Splats are
**not** baked with view-dependent spherical harmonics, as photogrammetric
splats are. Baked lighting would not match the focus tiers and would go stale
whenever the lighting preset changed (`web/src/viewer/lighting.ts`).

A per-splat part index is non-negotiable. It drives focus-set exclusion,
visibility, selection highlighting and the ID pass.

### Generation

Generation happens on the backend, per component, and is cached like GLB
assets today:

- **From SDF:** sample the bounds, project samples onto the zero set with
  `p - d·∇d`, and take orientation from the gradient.
- **From BREP or mesh:** area-weighted sampling of the tessellation at a fine
  tolerance, oriented by face normal.
- **Scale:** from local sample spacing, so disks overlap just enough to close
  the surface.
- **Level of detail:** a bounding-volume tree per component. Each interior
  node holds a merged, coarser splat set and a geometric error, for
  screen-space-error selection.

Generation is deterministic: seeded, ordered sampling. The same geometry
digest and parameters therefore give byte-identical assets, which the
content-addressed cache requires. Optimizing splats against reference renders
for higher quality is possible later, but it is not needed for context
rendering.

### Instancing and streaming

- Repeated components (thousands of identical fasteners) share one splat
  asset with per-instance transforms, as GLB assets do today. In a vehicle
  assembly this is likely the largest single memory saving.
- At extreme distances, a whole sub-assembly's context collapses to a merged
  LOD node built across its instances, so a million fasteners never cost a
  million draw records.
- LOD nodes are separately addressable assets streamed by the budget manager.
  This gives a hierarchy above the component level that `scene-v1` does not
  express today (see Contract changes).

### Limits

- Sections through context parts show no interior: a cut part is promoted to
  focus, which is one of the focus rules above.
- Splats are not used for measurement, clearance checks or any engineering
  output.
- Fine text and decals on context parts blur below their LOD. If they matter,
  the part belongs in focus.

## Contract changes (additive within v1)

- `sourceRepresentation` gains `"sdf"` and `"splat"`. Splat assets name the
  representation they were generated from.
- `tessellation` becomes required only for mesh assets. SDF assets carry the
  tree digest. Splat assets carry their sampling parameters and LOD error
  bounds.
- New media types:
  - `application/vnd.yapcad.sdf+json`: the `tree_to_json` document;
  - `application/vnd.yapcad.splats`: a binary LOD node; or a glTF splat
    extension, if one is standardized and fits the 2D-surfel layout. Check
    the state of Khronos splat-extension work before committing to a custom
    container.
- An optional **LOD hierarchy** section maps sub-assemblies to merged context
  assets, so the client can stream above the component level.
- A `set_focus` command and a `focus` field in the session snapshot.
- Session reading must accept `yapcad-geometry-json-v0.3`. Landed in #8,
  which accepts the schema and renders its preview meshes; consuming
  `representations.sdf` remains part of the field tier below.

The architecture's statement that browsers receive *derived render meshes*
generalizes to *derived render assets*. The SDF tree is sent as a display
derivative under the same rules: the browser never interprets it as
engineering state, and every measurement query goes to the backend.

## Determinism and agent renders

GPU output is not bit-identical across vendors, so screenshots from the
browser are not reproducible artifacts. `request_render` on the backend
should keep rendering focus geometry from meshes. A numpy ray marcher for SDF
parts is possible for single images, slow but deterministic. Splat context in
server renders is optional and must be flagged in the render's diagnostics.
The ID pass, not pixel color, is the agent-facing record of what is visible.

## Phasing

1. **Field tier.** In the viewer:
   - reading `representations.sdf` from the v0.3 record the loader already
     accepts (#8);
   - the GLSL generator for every current node kind;
   - proxy-box compositing with depth;
   - Lipschitz-safe stepping;
   - capped sections.

   In yapCAD, and a prerequisite for the generator's CI check rather than for
   the generator itself: the conformance fixture. The viewer work is an
   estimated one to two weeks; the fixture is not costed here and should be
   scheduled with yapCAD's meshing work, since it is the same per-node-kind
   audit.
2. **Field interaction.** Picking, x-ray, feature-edge "wireframe", subtree
   culling and progressive refinement.
3. **On-demand loading.**
   - replace fetch-everything in `load()` with budgeted streaming of the
     existing GLB assets;
   - add `set_focus` and the visibility bitmask.

   This is worthwhile on its own for large packages.
4. **Splat tier.**
   - backend generation from SDF and BREP;
   - the binary LOD format;
   - two-pass surface splatting;
   - instance-aware LOD;
   - the budget manager and automatic promotion.
5. **Scale-out.** WebGPU (three.js `WebGPURenderer`) for compute-based LOD
   selection, sparse distance-grid bricks, and GPU sorting for x-ray over
   splats.

Phase 3 comes before phase 4 on purpose: streaming and focus are the
scaffolding the splat tier plugs into, and they pay off on their own.

## Risks and open questions

- **GLSL evaluator drift.** Two evaluators can disagree. The conformance
  fixture is the mitigation, and it must be mandatory for new node kinds.
- **Ray-march cost on large trees.** Subtree culling may not be enough for
  trees with hundreds of nodes. The fallbacks are sampled grids or the
  existing mesh.
- **Splat quality at focus/context boundaries.** Shading and silhouette
  differences between a splat part and the meshed part next to it may be
  visible. Matching lighting models and a promotion hysteresis band (no
  flicker at the threshold) should be tested early on a real assembly.
- **WebGL2 limits.** Large splat counts without compute shaders mean
  CPU-driven LOD selection. Measure on target hardware before choosing
  whether phase 4 requires WebGPU.
- **Splat container.** A custom format versus a standardized glTF extension.
  Decide at phase 4, against what exists then.
- **Live SDF editing.** Whether parameter edits should round-trip through the
  backend (authoritative, revision-checked) or preview locally through the
  interpreter shader first.
- **Acceptance fixture.** The field tier has a cheap one available now: the
  engraved plate from problem statement 3, whose field is three lines of block
  text subtracted from a slab. It is a few hundred nodes, it is the case that
  defeats meshing, and anyone can regenerate it, so it should be the phase-1
  target — if lettering reads sharply at zoom and sections cap correctly, the
  tier works. The splat tier has no such shortcut: YapRover is far too small,
  and phase 4 needs a large synthetic assembly — many instanced fasteners,
  tubing and lattice parts, at 10^5+ instances.
