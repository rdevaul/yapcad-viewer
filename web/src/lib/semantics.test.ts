import { describe, expect, it } from "vitest";
import demoSession from "../../public/demo/session.json";
import type { YapcadViewerSessionSnapshotV1 } from "../contracts/session-v1";
import { partDepth, partIdsByDisposition, shortDigest } from "./semantics";

const session = demoSession as unknown as YapcadViewerSessionSnapshotV1;

describe("semantic package helpers", () => {
  it("groups repeated instances by component disposition", () => {
    const groups = partIdsByDisposition(session);
    expect(groups.make).toHaveLength(11);
    expect(groups.buy).toEqual([]);
  });

  it("computes hierarchy depth without looping on malformed cycles", () => {
    const root = session.parts.find((part) => part.id === "chassis")!;
    const wheel = session.parts.find((part) => part.id === "left_middle_wheel")!;
    expect(partDepth(root, session.parts)).toBe(0);
    expect(partDepth(wheel, session.parts)).toBe(3);

    const cyclic = [
      { ...root, id: "a", parentId: "b" },
      { ...root, id: "b", parentId: "a" },
    ];
    expect(partDepth(cyclic[0], cyclic)).toBe(1);
  });

  it("formats content digests compactly", () => {
    expect(shortDigest("sha256:0123456789abcdef")).toBe("01234567…abcdef");
  });
});
