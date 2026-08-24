# yapcad-viewer

`yapcad-viewer` is a human- and agent-operable viewer for
[yapCAD](https://github.com/rdevaul/yapCAD) `.ycpkg` engineering packages.

The application is deliberately agent-runtime-neutral. Humans use the web
interface, scripts use the REST API, and agents use an MCP adapter; all three
operate the same versioned package-session service.

This repository contains the architecture, protocol contracts, read-only
package-session application service, and browser workbench. The initial source
of UI concepts is yapCAD's historical
`feature/workbench-v2` branch, but code will be migrated by capability rather
than by merging that branch.

## Principles

- Analytic BREP in `yapcad-geometry-json-v0.2` remains authoritative.
- Product-definition packages are validated by yapCAD before a revision-zero
  semantic snapshot is created.
- Render meshes are deterministic, content-addressed GLB derivatives; repeated
  component instances share assets while retaining independent transforms.
- Browsers receive derived render meshes, not authoritative CAD state.
- Every state change uses an expected revision and produces an event.
- REST, WebSocket, and MCP are adapters over one domain service.
- Read-only inspection is the default; mutations are explicit and auditable.
- No agent harness, model provider, or chat implementation is built in.

See [the architecture](docs/architecture.md) and
[legacy extraction audit](docs/legacy-extraction.md).

## Browser workbench

The application in `web/` loads the versioned session and derived-scene
contracts directly. Its first inspection slice provides a semantic assembly
tree, part and package inspectors, disposition visibility groups, selectable
3D instances, fit and standard cameras, lighting modes, solid/wireframe/X-ray
rendering, and normalized section planes.

A deterministic 11-instance YapRover suspension scene is committed as the
offline demo. The fixture is derived from the standalone YapRover DSL using an
OpenCASCADE-enabled yapCAD environment, while the browser receives only
content-addressed GLB render assets and semantic JSON snapshots.

```bash
cd web
npm ci
npm run dev
```

See [the web application guide](web/README.md) for backend connection and
fixture-regeneration details.

## Contract tests

```bash
python -m pip install -e ../yapCAD  # until yapCAD 1.1 is released
python -m pip install -e '.[test]'
pytest
```

For an installed yapCAD 1.1 release, install `.[backend,test]` to include both
the viewer backend integration and test dependencies. The package-session
integration test generates a real v0.2 package when a compatible yapCAD is
present; transport-only CI can still run the contract and application tests
without OCC.

The schemas in `contracts/` define the transport-neutral v1 application
boundary and evolve under executable contract tests.

## License

MIT. See [LICENSE](LICENSE).
