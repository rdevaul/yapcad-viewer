# Legacy workbench extraction audit

Source audited: `rdevaul/yapCAD` branch `feature/workbench-v2`, commit
`ff193036e53d6f67aa549854d68e45201c57869f`.

The branch has no merge base with current yapCAD main. Files will be copied and
adapted only after their behavior is covered by the new contracts.

## Extract early

- `workbench/src/viewer/YapCADViewer.ts`: Three.js scene, camera, controls,
  render modes, and object interaction patterns.
- `workbench/src/viewer/lighting.ts`: reusable lighting presets.
- `workbench/src/components/ClippingControls.tsx`: section-plane UX.
- `workbench/src/components/LayerPanel.tsx`: visibility and layer UX.
- `workbench/src/components/LightingSelector.tsx` and
  `RenderModeSelector.tsx`: presentation controls.
- `workbench/src/utils/thumbnailRenderer.ts`: deterministic preview concepts.
- `workbench/src/components/SketchViewer.tsx`: possible later 2D viewer seed.

These modules must be changed to consume semantic scene snapshots and GLB
assets. They must not parse authoritative BREP or maintain independent part
identity.

## Use as behavioral reference

- `workbench/src/yapcad-loader.ts` and `utils/packageParser.ts`: useful package
  loading behavior, but currently tied to older schemas and browser-side
  parsing. Package validation and BREP interpretation move to the backend.
- `workbench/src/components/PackageSelector.tsx`: useful package-selection UX;
  replace its data path with session creation.
- `workbench/src/components/ParameterPanel.tsx`, `CommandSelector.tsx`, and
  `useWsEval.ts`: defer until package viewing and posing are stable.
- `service/routes/render.py`, `profile.py`, and `ws.py`: mine endpoint behavior,
  then reimplement behind versioned contracts and worker isolation.
- `workbench/specs/`: historical requirements, not normative contracts.

## Do not migrate into viewer v1

- `ChatPanel.tsx` and `useChat.ts`.
- `SessionBar.tsx` chat-session ownership.
- `SkillEditor.tsx` and bundled agent skill catalogs.
- Agent-runtime-specific WebSocket messages or named sessions.
- The duplicate `workbench/src/backend/` service.
- Direct file rewriting, git committing, or generic filesystem endpoints.
- Bundled deployment assumptions for OpenClaw or any other agent harness.
- The 246,000-line Hydra geometry fixture; YapRover will provide a maintained
  package acceptance fixture instead.

## Retire after replacement

- `yapcad.package.viewer` Pyglet implementation.
- `yapcad.viewer.api_server` Flask/SocketIO server.
- VTK-specific remote control as the primary API.

The VTK renderer may remain a separate optional desktop client if it adopts
the same session contracts. It should not define a second control protocol.
