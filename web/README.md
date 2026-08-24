# yapCAD Viewer web application

This is the browser adapter for the versioned `yapcad-viewer` application
contracts. It renders content-addressed GLB derivatives while retaining the
package's semantic part, component, BOM, material, datum, mate, and validation
identities in the interface.

The committed YapRover demo under `public/demo/` makes local development and
static previews independent of Python and OpenCASCADE. To connect to a running
viewer backend instead, set `NEXT_PUBLIC_YAPCAD_VIEWER_API` and open the app
with `?session=<session-id>&revision=<revision>`.

## Development

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run lint
npm test
```

`npm run generate:contracts` regenerates the TypeScript boundary from the
repository's JSON Schemas. From the repository root, regenerate the demo with
an OpenCASCADE-enabled yapCAD environment:

```bash
PYTHONPATH=backend:../yapCAD/src python scripts/generate_web_demo.py \
  --yaprover-root ../yapRover \
  --output web/public/demo
```
