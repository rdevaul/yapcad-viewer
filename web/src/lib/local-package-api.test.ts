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

function packageFiles(): FixtureFile[] {
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
      schema: yapcad-geometry-json-v0.2
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
      schema: "yapcad-geometry-json-v0.2",
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
    expect(session.parts).toHaveLength(37);
    expect(session.mates).toHaveLength(36);
    expect(scene.assets).toHaveLength(37);
    expect(scene.nodes.every((node) => node.assetId)).toBe(true);
    expect(scene.assets.every((asset) => asset.sourceRepresentation === "embedded-mesh")).toBe(true);
  });
});
