/* Generated from contracts/session-v1.schema.json. Do not edit. */

/**
 * Column-major homogeneous 4x4 transform
 *
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

export interface YapcadViewerSessionSnapshotV1 {
  schema: "yapcad-viewer-session-v1";
  sessionId: string;
  revision: number;
  package: {
    name: string;
    version: string;
    digest: string;
    rootPartId?: string | null;
  };
  parts: Part[];
  components: Component[];
  mates: Mate[];
  joints: Joint[];
  bom: {
    items: BomItem[];
  };
  materials: {
    [k: string]: {
      [k: string]: unknown;
    };
  };
  selection: string[];
  validation: {
    valid: boolean;
    errors: Diagnostic[];
    warnings: Diagnostic[];
  };
}
export interface Part {
  id: string;
  name: string;
  componentId: string;
  parentId?: string | null;
  materialId?: string | null;
  assetDigest?: string | null;
  transform: Matrix4;
  datums: Datum[];
  visible: boolean;
}
export interface Datum {
  id: string;
  kind: string;
  /**
   * @minItems 3
   * @maxItems 3
   */
  origin: [number, number, number];
  [k: string]: unknown;
}
export interface Component {
  id: string;
  name: string;
  description?: string | null;
  disposition: "make" | "buy" | "raw_stock" | "consumable";
  quantityPerInstance: number;
  unit: string;
  partNumber?: string | null;
  revision?: string | null;
  materialId?: string | null;
  manufacturing?: {
    [k: string]: unknown;
  } | null;
  procurement?: {
    [k: string]: unknown;
  } | null;
  pmi?: {
    [k: string]: unknown;
  } | null;
  assetDigest?: string | null;
}
export interface Mate {
  id: string;
  kind: string;
  partA: string;
  datumA: string;
  partB: string;
  datumB: string;
  offset?: number;
  angle?: number;
  limits?: {
    [k: string]: unknown;
  } | null;
}
export interface Joint {
  id: string;
  kind: string;
  value: number;
  unit: "radian" | "millimetre";
  minimum?: number | null;
  maximum?: number | null;
}
export interface BomItem {
  item: number;
  componentId: string;
  partNumber?: string | null;
  revision?: string | null;
  description: string;
  disposition: "make" | "buy" | "raw_stock" | "consumable";
  quantity: number;
  unit: string;
}
export interface Diagnostic {
  code: string;
  message: string;
  entityIds?: string[];
}
