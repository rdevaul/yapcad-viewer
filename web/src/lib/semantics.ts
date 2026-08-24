import type {
  Component,
  Part,
  YapcadViewerSessionSnapshotV1,
} from "../contracts/session-v1";

export type Disposition = Component["disposition"];

export const dispositionLabels: Record<Disposition, string> = {
  make: "Fabricated",
  buy: "COTS",
  raw_stock: "Raw stock",
  consumable: "Consumables",
};

export function partIdsByDisposition(
  session: YapcadViewerSessionSnapshotV1,
): Record<Disposition, string[]> {
  const componentById = new Map(session.components.map((item) => [item.id, item]));
  const result: Record<Disposition, string[]> = {
    make: [],
    buy: [],
    raw_stock: [],
    consumable: [],
  };
  for (const part of session.parts) {
    const disposition = componentById.get(part.componentId)?.disposition;
    if (disposition) result[disposition].push(part.id);
  }
  return result;
}

export function partDepth(part: Part, parts: Part[]): number {
  const byId = new Map(parts.map((item) => [item.id, item]));
  let current = part;
  let depth = 0;
  const visited = new Set([part.id]);
  while (current.parentId && depth < 8) {
    if (visited.has(current.parentId)) break;
    visited.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

export function shortDigest(digest: string): string {
  const value = digest.replace(/^sha256:/, "");
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
