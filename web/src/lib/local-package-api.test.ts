import { describe, expect, it } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { LocalPackageApi } from "./local-package-api";

interface FixtureFile {
  name: string;
  webkitRelativePath: string;
  size: number;
  text(): Promise<string>;
}

function fixtureFile(path: string, content: unknown): FixtureFile {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return {
    name: path.split("/").at(-1)!,
    webkitRelativePath: `fixture.ycpkg/${path}`,
    size: new TextEncoder().encode(text).byteLength,
    async text() { return text; },
  };
}

function packageFiles(
  geometrySchema = "yapcad-geometry-json-v0.2",
): FixtureFile[] {
  return [
    fixtureFile("manifest.yaml", `
schema: ycpkg-spec-v0.2
name: Local fixture
version: 0.2.0
components:
  - id: bracket
    name: Printed bracket
    disposition: make
    quantityPerInstance: 1
    unit: each
    material: petg
    geometry:
      path: geometry/entities/bracket.json
      schema: ${geometrySchema}
      hash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
instances:
  - id: bracket
    component: bracket
assembly:
  path: metadata/assembly.json
  rootPart: bracket
bom:
  path: metadata/bom.json
materials:
  petg:
    visual:
      color: [0.2, 0.7, 0.8]
`),
    fixtureFile("metadata/assembly.json", {
      rootPart: "bracket",
      parts: {
        bracket: {
          component: "bracket",
          transform: [[1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 1, 30], [0, 0, 0, 1]],
          datums: [{ id: "origin", kind: "point", origin: [0, 0, 0] }],
        },
      },
      mates: [],
      jointValues: {},
    }),
    fixtureFile("metadata/bom.json", {
      items: [{
        item: 1, component: "bracket", description: "Printed bracket",
        disposition: "make", quantity: 1, unit: "each",
      }],
    }),
    fixtureFile("geometry/entities/bracket.json", {
      schema: geometrySchema,
      entities: [{
        id: "surface-1",
        type: "surface",
        vertices: [[0, 0, 0, 1], [10, 0, 0, 1], [0, 10, 0, 1]],
        normals: [[0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0]],
        faces: [[0, 1, 2]],
      }],
    }),
  ];
}

describe("local .ycpkg adapter", () => {
  it("maps a selected package directory to semantic snapshots and GLB assets", async () => {
    const progress: string[] = [];
    const api = await LocalPackageApi.fromFiles(packageFiles(), (message) => progress.push(message));
    const { session, scene } = await api.loadInitial();

    expect(session.package).toMatchObject({ name: "Local fixture", version: "0.2.0" });
    expect(session.parts[0]).toMatchObject({
      id: "bracket", componentId: "bracket", materialId: "petg",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1],
    });
    expect(session.validation.warnings[0].code).toBe("local_mesh_preview");
    expect(session.validation.valid).toBe(false);
    expect(scene.nodes[0].assetId).toBe(scene.assets[0].id);
    expect(scene.assets[0].sourceRepresentation).toBe("embedded-mesh");
    const glb = await api.loadAsset(scene.assets[0].id);
    expect(new DataView(glb).getUint32(0, true)).toBe(0x46546c67);
    expect(progress.at(-1)).toContain("Printed bracket");
  });

  it("rejects directories that are not unpacked .ycpkg packages", async () => {
    const files = packageFiles().map((file) => ({
      ...file,
      webkitRelativePath: file.webkitRelativePath.replace("fixture.ycpkg", "fixture"),
    }));
    await expect(LocalPackageApi.fromFiles(files)).rejects.toThrow(
      "Selected directory must end in .ycpkg",
    );
  });

  it("reads yapcad-geometry-json-v0.3 preview meshes", async () => {
    const api = await LocalPackageApi.fromFiles(
      packageFiles("yapcad-geometry-json-v0.3"),
    );
    const { scene } = await api.loadInitial();
    expect(scene.assets).toHaveLength(1);
    expect(scene.assets[0].sourceRepresentation).toBe("embedded-mesh");
    const glb = await api.loadAsset(scene.assets[0].id);
    expect(new DataView(glb).getUint32(0, true)).toBe(0x46546c67);
  });

  it("rejects geometry schemas it cannot read", async () => {
    await expect(
      LocalPackageApi.fromFiles(packageFiles("yapcad-geometry-json-v9.9")),
    ).rejects.toThrow("unsupported geometry schema yapcad-geometry-json-v9.9");
  });

  const realPackage = process.env.YAPCAD_VIEWER_TEST_PACKAGE;
  it.skipIf(!realPackage)("opens a generated YapRover package when requested", async () => {
    const root = path.resolve(realPackage!);
    const members = await readdir(root, { recursive: true, withFileTypes: true });
    const files = await Promise.all(members.filter((member) => member.isFile()).map(async (member) => {
      const absolute = path.join(member.parentPath, member.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      const info = await stat(absolute);
      return {
        name: member.name,
        webkitRelativePath: `${path.basename(root)}/${relative}`,
        size: info.size,
        async text() { return (await readFile(absolute)).toString("utf-8"); },
      };
    }));

    const api = await LocalPackageApi.fromFiles(files);
    const { session, scene } = await api.loadInitial();
    // Counts are package-specific (yaprover 0.1.0 had 37 parts, 0.2.0 has 65),
    // so assert the structural invariants instead of a particular revision.
    expect(session.parts.length).toBeGreaterThan(0);
    expect(session.mates.length).toBeGreaterThan(0);
    expect(scene.nodes).toHaveLength(session.parts.length);
    expect(scene.assets.length).toBeGreaterThan(0);
    expect(scene.assets.length).toBeLessThanOrEqual(session.components.length);
    expect(scene.nodes.every((node) => node.assetId)).toBe(true);
    expect(scene.assets.every((asset) => asset.sourceRepresentation === "embedded-mesh")).toBe(true);
  });
});
