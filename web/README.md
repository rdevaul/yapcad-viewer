# yapCAD Viewer web application

This is the browser adapter for the versioned `yapcad-viewer` application
contracts. It renders content-addressed GLB derivatives while retaining the
package's semantic part, component, BOM, material, datum, mate, and validation
identities in the interface.

The committed YapRover demo under `public/demo/` makes local development and
static previews independent of Python and OpenCASCADE. To connect to a running
viewer backend instead, set `NEXT_PUBLIC_YAPCAD_VIEWER_API` and open the app
with `?session=<session-id>&revision=<revision>`.

Use **Open local** in the top bar to inspect an unpacked `.ycpkg` directory
without uploading it or starting the Python backend. The browser reads the
v0.2 manifest, assembly graph, BOM, materials, and component geometry selected
through the directory picker. It renders the embedded preview meshes and does
not decode, modify, or claim to validate the authoritative OpenCASCADE BREP.
Run yapCAD's strict package validation separately for engineering acceptance.

Browser-local import currently supports directory-form `ycpkg-spec-v0.2`
packages up to 2 GB and 20,000 files. Compressed package archives and
browser-side posing remain future compatibility work.

## Development

Requires Node.js 22.13 or newer. CI exercises both Node.js 22 and the current
Node.js 24 LTS line; its Node 24 lane also rejects high-severity npm advisories.

```bash
npm ci
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run lint
npm test
npm audit --audit-level=high
```

`npm run generate:contracts` regenerates the TypeScript boundary from the
repository's JSON Schemas. From the repository root, regenerate the demo with
an OpenCASCADE-enabled yapCAD environment:

```bash
PYTHONPATH=backend:../yapCAD/src python scripts/generate_web_demo.py \
  --yaprover-root ../yapRover \
  --output web/public/demo
```
