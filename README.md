# yapcad-viewer

`yapcad-viewer` is a human- and agent-operable viewer for
[yapCAD](https://github.com/rdevaul/yapCAD) `.ycpkg` engineering packages.

The application is deliberately agent-runtime-neutral. Humans use the web
interface, scripts use the REST API, and agents use an MCP adapter; all three
operate the same versioned package-session service.

This repository is in its architecture and contract-bootstrap phase. The
initial source of UI concepts is yapCAD's historical
`feature/workbench-v2` branch, but code will be migrated by capability rather
than by merging that branch.

## Principles

- Analytic BREP in `yapcad-geometry-json-v0.2` remains authoritative.
- Browsers receive derived render meshes, not authoritative CAD state.
- Every state change uses an expected revision and produces an event.
- REST, WebSocket, and MCP are adapters over one domain service.
- Read-only inspection is the default; mutations are explicit and auditable.
- No agent harness, model provider, or chat implementation is built in.

See [the architecture](docs/architecture.md) and
[legacy extraction audit](docs/legacy-extraction.md).

## Contract tests

```bash
python -m pip install -e '.[test]'
pytest
```

The schemas in `contracts/` are an early v1 contract and will evolve through
review before implementation begins.

## License

MIT. See [LICENSE](LICENSE).
