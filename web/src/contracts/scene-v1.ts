/* Generated from contracts/scene-v1.schema.json. Do not edit. */

export type Digest = string;
/**
 * @minItems 16
 * @maxItems 16
 */
export type Matrix4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number
];

export interface YapcadViewerDerivedSceneV1 {
  schema: "yapcad-viewer-scene-v1";
  sessionId: string;
  revision: number;
  digest: Digest;
  units: "millimetre";
  assets: Asset[];
  nodes: Node[];
  diagnostics: Diagnostic[];
}
export interface Asset {
  id: Digest;
  componentId: string;
  mediaType: "model/gltf-binary";
  byteLength: number;
  sourceRepresentation: "brep" | "embedded-mesh";
  derivationDigest: Digest;
  generatorFingerprint: string;
  tessellation: {
    linearDeflectionMm: number;
    angularDeflectionRad: number;
  };
}
export interface Node {
  id: string;
  name: string;
  componentId: string;
  parentId: string | null;
  materialId: string | null;
  assetId: Digest | null;
  transform: Matrix4;
  visible: boolean;
}
export interface Diagnostic {
  code: string;
  message: string;
  entityIds: string[];
}
