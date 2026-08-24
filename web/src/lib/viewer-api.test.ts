import { afterEach, describe, expect, it, vi } from "vitest";
import demoScene from "../../public/demo/scene.json";
import demoSession from "../../public/demo/session.json";
import { BundledDemoApi, HttpViewerApi, createViewerApi } from "./viewer-api";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_YAPCAD_VIEWER_API;
});

function installFetch() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("session.json") || url.endsWith("/sessions/session%2Fone")) {
      return Response.json(demoSession);
    }
    if (url.includes("scene?atRevision=")) return Response.json(demoScene);
    if (url.endsWith("scene.json")) return Response.json(demoScene);
    return new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("viewer data adapters", () => {
  it("loads the committed demo without a backend", async () => {
    const fetchMock = installFetch();
    const api = new BundledDemoApi();
    const initial = await api.loadInitial();
    await api.loadAsset("sha256:abc123");

    expect(initial.session.parts).toHaveLength(11);
    expect(initial.scene.nodes).toHaveLength(11);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/demo/session.json",
      "/demo/scene.json",
      "/demo/assets/abc123.glb",
    ]);
  });

  it("uses the versioned HTTP API when configured", async () => {
    const fetchMock = installFetch();
    const api = new HttpViewerApi("https://viewer.example", "session/one", 7);
    await api.loadInitial();
    await api.loadAsset("sha256:abc/123");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://viewer.example/v1/sessions/session%2Fone",
      "https://viewer.example/v1/sessions/session%2Fone/scene?atRevision=7",
      "https://viewer.example/v1/assets/sha256%3Aabc%2F123",
    ]);
  });

  it("falls back safely for incomplete or invalid URL configuration", () => {
    process.env.NEXT_PUBLIC_YAPCAD_VIEWER_API = "https://viewer.example/";
    expect(createViewerApi("?session=one&revision=3")).toBeInstanceOf(HttpViewerApi);
    expect(createViewerApi("?revision=3")).toBeInstanceOf(BundledDemoApi);
    expect(createViewerApi("?session=one&revision=-1")).toBeInstanceOf(BundledDemoApi);
  });

  it("turns non-success responses into stable viewer errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(new BundledDemoApi().loadInitial()).rejects.toThrow(
      "Viewer request failed (404)",
    );
  });
});
