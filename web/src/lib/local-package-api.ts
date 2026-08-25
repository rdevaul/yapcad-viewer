import { parse as parseYaml } from "yaml";
import type {
  Component,
  Datum,
  Matrix4 as SessionMatrix4,
  YapcadViewerSessionSnapshotV1,
} from "../contracts/session-v1";
import type {
  Matrix4 as SceneMatrix4,
  YapcadViewerDerivedSceneV1,
} from "../contracts/scene-v1";
import type { InitialViewerState, ViewerApi } from "./viewer-api";

const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PACKAGE_FILES = 20_000;
const LOCAL_GENERATOR = "yapcad-viewer-browser-mesh-v1";
const TESSELLATION = { linearDeflectionMm: 0.25, angularDeflectionRad: 0.5 };

type JsonObject = Record<string, unknown>;

interface PackageFile {
  name: string;
  webkitRelativePath?: string;
  size: number;
  text(): Promise<string>;
}

interface LocalComponent extends JsonObject {
  id: string;
  name?: string;
  description?: string;
  disposition: Component["disposition"];
  quantityPerInstance?: number;
  unit?: string;
  partNumber?: string | null;
  revision?: string | null;
  material?: string | null;
  manufacturing?: JsonObject | null;
  procurement?: JsonObject | null;
  pmi?: JsonObject | null;
  geometry?: { path?: string; hash?: string; schema?: string };
}

interface LocalManifest extends JsonObject {
  schema: string;
  name?: string;
  version?: string | number;
  components?: LocalComponent[];
  instances?: Array<{ id: string; component: string; transform?: number[][] }>;
  assembly?: { path?: string; rootPart?: string | null };
  bom?: { path?: string };
  materials?: Record<string, JsonObject>;
}

interface AssemblyRecord extends JsonObject {
  rootPart?: string | null;
  parts?: Record<string, {
    component?: string;
    transform?: number[][];
    datums?: Datum[];
  }>;
  mates?: Array<Record<string, unknown>>;
  jointValues?: Record<string, number>;
}

interface BomRecord extends JsonObject {
  items?: Array<Record<string, unknown>>;
}

interface SurfaceEntity extends JsonObject {
  type: "surface";
  vertices: number[][];
  faces: number[][];
}

interface GeometryDocument extends JsonObject {
  schema: string;
  entities: Array<SurfaceEntity | JsonObject>;
}

export class LocalPackageApi implements ViewerApi {
  private constructor(
    private readonly initial: InitialViewerState,
    private readonly assets: Map<string, ArrayBuffer>,
  ) {}

  static async fromFiles(
    input: FileList | Iterable<PackageFile>,
    onProgress: (message: string) => void = () => undefined,
  ): Promise<LocalPackageApi> {
    const files = Array.from(input as Iterable<PackageFile>);
    if (!files.length) throw new Error("Choose an unpacked .ycpkg directory");
    if (files.length > MAX_PACKAGE_FILES) throw new Error("Package contains too many files");
    const packageBytes = files.reduce((total, file) => total + file.size, 0);
    if (packageBytes > MAX_PACKAGE_BYTES) throw new Error("Package exceeds the 2 GB local limit");

    const manifestFile = files.find((file) => filePath(file).endsWith("/manifest.yaml"))
      ?? files.find((file) => filePath(file) === "manifest.yaml");
    if (!manifestFile) throw new Error("Selected directory has no manifest.yaml");
    const manifestPath = filePath(manifestFile);
    const prefix = manifestPath.slice(0, manifestPath.length - "manifest.yaml".length);
    if (prefix && !prefix.slice(0, -1).endsWith(".ycpkg")) {
      throw new Error("Selected directory must end in .ycpkg");
    }
    const members = new Map<string, PackageFile>();
    for (const file of files) {
      const path = filePath(file);
      if (!path.startsWith(prefix)) continue;
      const relative = normalizedMember(path.slice(prefix.length));
      if (members.has(relative)) throw new Error(`Duplicate package member: ${relative}`);
      members.set(relative, file);
    }

    onProgress("Reading package manifest…");
    const manifestText = await requiredFile(members, "manifest.yaml").text();
    const manifest = parseYaml(manifestText) as LocalManifest;
    if (!manifest || manifest.schema !== "ycpkg-spec-v0.2") {
      throw new Error(`Local preview requires ycpkg-spec-v0.2; found ${manifest?.schema ?? "unknown"}`);
    }
    const components = manifest.components ?? [];
    if (!components.length) throw new Error("Package manifest has no components");
    const assemblyPath = requiredPath(manifest.assembly?.path, "assembly metadata");
    const bomPath = requiredPath(manifest.bom?.path, "BOM metadata");
    const [assembly, bom] = await Promise.all([
      readJson<AssemblyRecord>(members, assemblyPath),
      readJson<BomRecord>(members, bomPath),
    ]);

    const packageDigest = await digestBytes(new TextEncoder().encode(manifestText));
    const sessionId = crypto.randomUUID();
    const session = buildSession(manifest, assembly, bom, sessionId, packageDigest);
    const assets = new Map<string, ArrayBuffer>();
    const sceneAssets: YapcadViewerDerivedSceneV1["assets"] = [];
    for (const [index, component] of components.entries()) {
      if (!component.geometry?.path) continue;
      onProgress(`Preparing ${component.name ?? component.id} (${index + 1}/${components.length})…`);
      const geometry = await readJson<GeometryDocument>(members, component.geometry.path);
      if (geometry.schema !== "yapcad-geometry-json-v0.2") {
        throw new Error(`Component ${component.id} uses unsupported geometry schema ${geometry.schema}`);
      }
      const glb = geometryDocumentToGlb(geometry, component.id);
      const assetId = await digestBytes(new Uint8Array(glb));
      const derivationDigest = await digestText(
        `${component.id}:${component.geometry.hash ?? "unhashed"}:${LOCAL_GENERATOR}`,
      );
      assets.set(assetId, glb);
      sceneAssets.push({
        id: assetId,
        componentId: component.id,
        mediaType: "model/gltf-binary",
        byteLength: glb.byteLength,
        sourceRepresentation: "embedded-mesh",
        derivationDigest,
        generatorFingerprint: LOCAL_GENERATOR,
        tessellation: TESSELLATION,
      });
    }

    const assetByComponent = new Map(sceneAssets.map((asset) => [asset.componentId, asset.id]));
    const nodes = session.parts.map((part) => ({
      id: part.id,
      name: part.name,
      componentId: part.componentId,
      parentId: part.parentId ?? null,
      materialId: part.materialId ?? null,
      assetId: assetByComponent.get(part.componentId) ?? null,
      transform: part.transform as SceneMatrix4,
      visible: part.visible,
    }));
    const sceneCore = {
      schema: "yapcad-viewer-scene-v1" as const,
      sessionId,
      revision: 0,
      units: "millimetre" as const,
      assets: sceneAssets,
      nodes,
      diagnostics: [],
    };
    const scene: YapcadViewerDerivedSceneV1 = {
      ...sceneCore,
      digest: await digestText(JSON.stringify(sceneCore)),
    };
    return new LocalPackageApi({ session, scene }, assets);
  }

  async loadInitial(): Promise<InitialViewerState> {
    return this.initial;
  }

  async loadAsset(assetId: string): Promise<ArrayBuffer> {
    const asset = this.assets.get(assetId);
    if (!asset) throw new Error(`Local render asset is unavailable: ${assetId}`);
    return asset.slice(0);
  }
}

function buildSession(
  manifest: LocalManifest,
  assembly: AssemblyRecord,
  bom: BomRecord,
  sessionId: string,
  packageDigest: string,
): YapcadViewerSessionSnapshotV1 {
  const manifestComponents = manifest.components ?? [];
  const componentById = new Map(manifestComponents.map((component) => [component.id, component]));
  const instanceById = new Map((manifest.instances ?? []).map((instance) => [instance.id, instance]));
  const partsRecord = assembly.parts ?? {};
  const matesRecord = assembly.mates ?? [];
  const rootPart = assembly.rootPart ?? manifest.assembly?.rootPart ?? null;
  const parents = deriveParents(rootPart, Object.keys(partsRecord), matesRecord);
  const components: Component[] = manifestComponents.map((component) => ({
    id: component.id,
    name: component.name ?? component.id,
    description: component.description ?? null,
    disposition: component.disposition,
    quantityPerInstance: component.quantityPerInstance ?? 1,
    unit: component.unit ?? "each",
    partNumber: component.partNumber ?? null,
    revision: component.revision ?? null,
    materialId: component.material ?? null,
    manufacturing: component.manufacturing ?? null,
    procurement: component.procurement ?? null,
    pmi: component.pmi ?? null,
    assetDigest: normalizedDigest(component.geometry?.hash),
  }));
  const parts = Object.entries(partsRecord).map(([id, part]) => {
    const instance = instanceById.get(id);
    const componentId = part.component ?? instance?.component;
    if (!componentId || !componentById.has(componentId)) {
      throw new Error(`Part ${id} references an unknown component`);
    }
    return {
      id,
      name: humanName(id),
      componentId,
      parentId: parents.get(id) ?? null,
      materialId: componentById.get(componentId)?.material ?? null,
      assetDigest: normalizedDigest(componentById.get(componentId)?.geometry?.hash),
      transform: columnMajor(part.transform ?? instance?.transform),
      datums: part.datums ?? [],
      visible: true,
    };
  });
  const mates = matesRecord.map((mate) => ({
    id: requiredString(mate.id, "mate id"),
    kind: requiredString(mate.kind, "mate kind"),
    partA: requiredString(mate.partA, "mate partA"),
    datumA: requiredString(mate.datumA, "mate datumA"),
    partB: requiredString(mate.partB, "mate partB"),
    datumB: requiredString(mate.datumB, "mate datumB"),
    offset: Number(mate.offset ?? 0),
    angle: Number(mate.angle ?? 0),
    limits: (mate.limits as JsonObject | null | undefined) ?? null,
  }));
  const jointValues = assembly.jointValues ?? {};
  const joints = matesRecord.flatMap((mate) => {
    const id = requiredString(mate.id, "mate id");
    const kind = requiredString(mate.kind, "mate kind");
    if (!(id in jointValues) && kind !== "revolute" && kind !== "prismatic") return [];
    const limits = (mate.limits as JsonObject | undefined) ?? {};
    return [{
      id,
      kind,
      value: Number(jointValues[id] ?? 0),
      unit: kind === "prismatic" ? "millimetre" as const : "radian" as const,
      minimum: finiteOrNull(limits.min_value),
      maximum: finiteOrNull(limits.max_value),
    }];
  });
  return {
    schema: "yapcad-viewer-session-v1",
    sessionId,
    revision: 0,
    package: {
      name: manifest.name ?? "Local package",
      version: String(manifest.version ?? "0"),
      digest: packageDigest,
      rootPartId: rootPart,
    },
    components,
    parts,
    mates,
    joints,
    bom: {
      items: (bom.items ?? []).map((item) => ({
        item: Number(item.item),
        componentId: requiredString(item.component, "BOM component"),
        partNumber: optionalString(item.partNumber),
        revision: optionalString(item.revision),
        description: String(item.description ?? ""),
        disposition: item.disposition as Component["disposition"],
        quantity: Number(item.quantity ?? 0),
        unit: String(item.unit ?? "each"),
      })),
    },
    materials: manifest.materials ?? {},
    selection: [],
    validation: {
      valid: false,
      errors: [],
      warnings: [{
        code: "local_mesh_preview",
        message: "Opened locally using embedded preview meshes; analytic BREP remains authoritative but is not validated in the browser.",
        entityIds: [],
      }],
    },
  };
}

function geometryDocumentToGlb(document: GeometryDocument, componentId: string): ArrayBuffer {
  const positions: number[] = [];
  const triangles: number[] = [];
  for (const entity of document.entities) {
    if (entity.type !== "surface") continue;
    const surface = entity as SurfaceEntity;
    const offset = positions.length / 3;
    for (const vertex of surface.vertices ?? []) positions.push(vertex[0], vertex[1], vertex[2]);
    for (const face of surface.faces ?? []) {
      for (let index = 1; index + 1 < face.length; index += 1) {
        triangles.push(offset + face[0], offset + face[index], offset + face[index + 1]);
      }
    }
  }
  if (!positions.length || !triangles.length) {
    throw new Error(`Component ${componentId} has no embedded preview mesh`);
  }
  const normals = vertexNormals(positions, triangles);
  const positionBytes = new Uint8Array(new Float32Array(positions).buffer);
  const normalBytes = new Uint8Array(new Float32Array(normals).buffer);
  const indexBytes = new Uint8Array(new Uint32Array(triangles).buffer);
  const binary = concatBytes(positionBytes, normalBytes, indexBytes);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  const gltf = {
    asset: { version: "2.0", generator: LOCAL_GENERATOR },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: componentId, mesh: 0, extras: { componentId } }],
    meshes: [{ name: componentId, primitives: [{
      attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 4,
    }] }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.byteLength, byteLength: normalBytes.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.byteLength + normalBytes.byteLength, byteLength: indexBytes.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min: minimum, max: maximum },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: "VEC3" },
      { bufferView: 2, componentType: 5125, count: triangles.length, type: "SCALAR" },
    ],
    extras: { units: "millimetre", sourceRepresentation: "embedded-mesh" },
  };
  const json = paddedBytes(new TextEncoder().encode(JSON.stringify(gltf)), 0x20);
  const bin = paddedBytes(binary, 0x00);
  const result = new ArrayBuffer(12 + 8 + json.byteLength + 8 + bin.byteLength);
  const view = new DataView(result);
  let cursor = 0;
  view.setUint32(cursor, 0x46546c67, true); cursor += 4;
  view.setUint32(cursor, 2, true); cursor += 4;
  view.setUint32(cursor, result.byteLength, true); cursor += 4;
  view.setUint32(cursor, json.byteLength, true); cursor += 4;
  view.setUint32(cursor, 0x4e4f534a, true); cursor += 4;
  new Uint8Array(result, cursor, json.byteLength).set(json); cursor += json.byteLength;
  view.setUint32(cursor, bin.byteLength, true); cursor += 4;
  view.setUint32(cursor, 0x004e4942, true); cursor += 4;
  new Uint8Array(result, cursor, bin.byteLength).set(bin);
  return result;
}

function vertexNormals(positions: number[], triangles: number[]): number[] {
  const normals = Array(positions.length).fill(0) as number[];
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index] * 3;
    const b = triangles[index + 1] * 3;
    const c = triangles[index + 2] * 3;
    const ab = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const ac = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    for (const vertex of [a, b, c]) {
      normals[vertex] += normal[0];
      normals[vertex + 1] += normal[1];
      normals[vertex + 2] += normal[2];
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1;
    normals[index] /= length;
    normals[index + 1] /= length;
    normals[index + 2] /= length;
  }
  return normals;
}

function deriveParents(
  root: string | null,
  partIds: string[],
  mates: Array<Record<string, unknown>>,
): Map<string, string | null> {
  const parents = new Map<string, string | null>(partIds.map((id) => [id, null]));
  if (!root || !parents.has(root)) return parents;
  const adjacency = new Map(partIds.map((id) => [id, [] as string[]]));
  for (const mate of mates) {
    const a = typeof mate.partA === "string" ? mate.partA : "";
    const b = typeof mate.partB === "string" ? mate.partB : "";
    if (adjacency.has(a) && adjacency.has(b)) {
      adjacency.get(a)!.push(b);
      adjacency.get(b)!.push(a);
    }
  }
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of adjacency.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      parents.set(child, parent);
      queue.push(child);
    }
  }
  return parents;
}

function columnMajor(matrix: number[][] | undefined): SessionMatrix4 {
  if (!matrix || matrix.length !== 4 || matrix.some((row) => row.length !== 4)) {
    throw new Error("Part has no valid solved 4x4 transform");
  }
  return Array.from({ length: 16 }, (_, index) => matrix[index % 4][Math.floor(index / 4)]) as SessionMatrix4;
}

function filePath(file: PackageFile): string {
  return (file.webkitRelativePath || file.name).replaceAll("\\", "/");
}

function normalizedMember(path: string): string {
  const parts = path.split("/");
  if (!path || path.startsWith("/") || parts.some((part) => part === ".." || !part)) {
    throw new Error(`Unsafe package member path: ${path}`);
  }
  return parts.join("/");
}

function requiredFile(files: Map<string, PackageFile>, path: string): PackageFile {
  const file = files.get(normalizedMember(path));
  if (!file) throw new Error(`Package member is missing: ${path}`);
  return file;
}

async function readJson<T>(files: Map<string, PackageFile>, path: string): Promise<T> {
  try {
    return JSON.parse(await requiredFile(files, path).text()) as T;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Package member")) throw error;
    throw new Error(`Invalid JSON package member: ${path}`);
  }
}

function requiredPath(value: unknown, description: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Manifest has no ${description} path`);
  return normalizedMember(value);
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Package has no ${description}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function normalizedDigest(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function humanName(value: string): string {
  const words = value.replaceAll("_", " ").replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function digestText(value: string): Promise<string> {
  return digestBytes(new TextEncoder().encode(value));
}

async function digestBytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function paddedBytes(value: Uint8Array, fill: number): Uint8Array {
  const result = new Uint8Array((value.byteLength + 3) & ~3);
  result.fill(fill);
  result.set(value);
  return result;
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}
