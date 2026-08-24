import type { YapcadViewerDerivedSceneV1 } from "../contracts/scene-v1";
import type { YapcadViewerSessionSnapshotV1 } from "../contracts/session-v1";

export interface InitialViewerState {
  session: YapcadViewerSessionSnapshotV1;
  scene: YapcadViewerDerivedSceneV1;
}

export interface ViewerApi {
  loadInitial(): Promise<InitialViewerState>;
  loadAsset(assetId: string): Promise<ArrayBuffer>;
}

async function checkedFetch(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Viewer request failed (${response.status})`);
  }
  return response;
}

export class BundledDemoApi implements ViewerApi {
  async loadInitial(): Promise<InitialViewerState> {
    const [sessionResponse, sceneResponse] = await Promise.all([
      checkedFetch("/demo/session.json"),
      checkedFetch("/demo/scene.json"),
    ]);
    return {
      session: (await sessionResponse.json()) as YapcadViewerSessionSnapshotV1,
      scene: (await sceneResponse.json()) as YapcadViewerDerivedSceneV1,
    };
  }

  async loadAsset(assetId: string): Promise<ArrayBuffer> {
    const digest = assetId.replace(/^sha256:/, "");
    return (await checkedFetch(`/demo/assets/${digest}.glb`)).arrayBuffer();
  }
}

export class HttpViewerApi implements ViewerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly revision: number,
  ) {}

  async loadInitial(): Promise<InitialViewerState> {
    const sessionPath = `${this.baseUrl}/v1/sessions/${encodeURIComponent(this.sessionId)}`;
    const scenePath = `${sessionPath}/scene?atRevision=${this.revision}`;
    const [sessionResponse, sceneResponse] = await Promise.all([
      checkedFetch(sessionPath),
      checkedFetch(scenePath),
    ]);
    return {
      session: (await sessionResponse.json()) as YapcadViewerSessionSnapshotV1,
      scene: (await sceneResponse.json()) as YapcadViewerDerivedSceneV1,
    };
  }

  async loadAsset(assetId: string): Promise<ArrayBuffer> {
    const path = `${this.baseUrl}/v1/assets/${encodeURIComponent(assetId)}`;
    return (await checkedFetch(path)).arrayBuffer();
  }
}

export function createViewerApi(search = ""): ViewerApi {
  const query = new URLSearchParams(search);
  const baseUrl = process.env.NEXT_PUBLIC_YAPCAD_VIEWER_API?.replace(/\/$/, "");
  const sessionId = query.get("session");
  const revision = Number(query.get("revision") ?? "0");
  if (baseUrl && sessionId && Number.isInteger(revision) && revision >= 0) {
    return new HttpViewerApi(baseUrl, sessionId, revision);
  }
  return new BundledDemoApi();
}
