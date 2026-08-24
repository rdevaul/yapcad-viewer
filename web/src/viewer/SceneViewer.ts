import {
  ACESFilmicToneMapping,
  Box3,
  BufferGeometry,
  Color,
  DoubleSide,
  GridHelper,
  Group,
  Light,
  Material,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Sphere,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { YapcadViewerDerivedSceneV1 } from "../contracts/scene-v1";
import type {
  Component,
  YapcadViewerSessionSnapshotV1,
} from "../contracts/session-v1";
import type { ViewerApi } from "../lib/viewer-api";
import { createLights, type LightingPresetName } from "./lighting";

export type RenderMode = "solid" | "wireframe" | "xray";
export type StandardView = "isometric" | "front" | "right" | "top";
export type ClipAxis = "x" | "y" | "z";

interface ViewerCallbacks {
  onSelect(partId: string | null): void;
}

export class SceneViewer {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.1, 10000);
  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly loader = new GLTFLoader();
  private readonly root = new Group();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly partGroups = new Map<string, Group>();
  private readonly partMeshes = new Map<string, Mesh[]>();
  private readonly clippingPlanes = new Map<ClipAxis, Plane>();
  private readonly lights: Light[] = [];
  private readonly grid = new GridHelper(1000, 20, 0x385267, 0x233746);
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;
  private selectedPartId: string | null = null;
  private pointerOrigin: { x: number; y: number } | null = null;
  private bounds = new Box3();

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: ViewerCallbacks,
  ) {
    this.scene.background = new Color(0x091017);
    this.scene.add(this.root);
    this.grid.rotateX(Math.PI / 2);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.45;
    this.scene.add(this.grid);
    this.camera.up.set(0, 0, 1);
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.localClippingEnabled = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.screenSpacePanning = true;
    this.setLighting("studio");
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.resize();
    this.animate();
  }

  async load(
    session: YapcadViewerSessionSnapshotV1,
    sceneSnapshot: YapcadViewerDerivedSceneV1,
    api: ViewerApi,
  ): Promise<void> {
    this.clearParts();
    const assetTemplates = new Map<string, Group>();
    await Promise.all(
      sceneSnapshot.assets.map(async (asset) => {
        const buffer = await api.loadAsset(asset.id);
        const gltf = await this.loader.parseAsync(buffer, "");
        assetTemplates.set(asset.id, gltf.scene);
      }),
    );
    const components = new Map(session.components.map((item) => [item.id, item]));
    for (const node of sceneSnapshot.nodes) {
      if (!node.assetId) continue;
      const template = assetTemplates.get(node.assetId);
      if (!template) continue;
      const instance = template.clone(true);
      instance.name = node.name;
      instance.matrixAutoUpdate = false;
      instance.matrix.fromArray(node.transform);
      instance.visible = node.visible;
      const meshes: Mesh[] = [];
      instance.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.material = this.materialFor(
          object.material,
          node.materialId,
          components.get(node.componentId),
          session,
        );
        object.userData.partId = node.id;
        object.userData.componentId = node.componentId;
        object.userData.materialId = node.materialId;
        meshes.push(object);
      });
      this.partGroups.set(node.id, instance);
      this.partMeshes.set(node.id, meshes);
      this.root.add(instance);
    }
    this.root.updateMatrixWorld(true);
    this.bounds = new Box3().setFromObject(this.root);
    if (!this.bounds.isEmpty()) {
      this.grid.position.z = this.bounds.min.z;
    }
    this.fitToView();
  }

  setSelected(partId: string | null, notify = false): void {
    if (this.selectedPartId) this.highlight(this.selectedPartId, false);
    this.selectedPartId = partId;
    if (partId) this.highlight(partId, true);
    if (notify) this.callbacks.onSelect(partId);
  }

  setPartsVisible(partIds: string[], visible: boolean): void {
    for (const partId of partIds) {
      const group = this.partGroups.get(partId);
      if (group) group.visible = visible;
    }
  }

  setRenderMode(mode: RenderMode): void {
    for (const meshes of this.partMeshes.values()) {
      for (const mesh of meshes) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (!(material instanceof MeshStandardMaterial)) continue;
          material.wireframe = mode === "wireframe";
          material.transparent = mode === "xray";
          material.opacity = mode === "xray" ? 0.28 : 1;
          material.depthWrite = mode !== "xray";
        }
      }
    }
  }

  setLighting(preset: LightingPresetName): void {
    for (const light of this.lights.splice(0)) this.scene.remove(light);
    this.lights.push(...createLights(preset));
    for (const light of this.lights) this.scene.add(light);
  }

  setClipPlane(
    axis: ClipAxis,
    enabled: boolean,
    normalizedPosition: number,
    inverted: boolean,
  ): void {
    if (!enabled || this.bounds.isEmpty()) {
      this.clippingPlanes.delete(axis);
    } else {
      const index = { x: 0, y: 1, z: 2 }[axis];
      const min = this.bounds.min.getComponent(index);
      const max = this.bounds.max.getComponent(index);
      const position = min + (max - min) * normalizedPosition;
      const normal = new Vector3();
      normal.setComponent(index, inverted ? 1 : -1);
      this.clippingPlanes.set(axis, new Plane(normal, inverted ? -position : position));
    }
    this.renderer.clippingPlanes = [...this.clippingPlanes.values()];
  }

  setStandardView(view: StandardView): void {
    const directions: Record<StandardView, Vector3> = {
      isometric: new Vector3(1, -1, 0.78),
      front: new Vector3(0, -1, 0),
      right: new Vector3(1, 0, 0),
      top: new Vector3(0, 0, 1),
    };
    this.fitToView(directions[view]);
  }

  fitToView(direction = new Vector3(1, -1, 0.78)): void {
    if (this.bounds.isEmpty()) return;
    const center = this.bounds.getCenter(new Vector3());
    const sphere = this.bounds.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 1);
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.15;
    this.camera.position.copy(center).add(direction.normalize().multiplyScalar(distance));
    this.camera.near = Math.max(distance / 1000, 0.01);
    this.camera.far = distance * 10;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.controls.dispose();
    this.clearParts();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private materialFor(
    material: Material | Material[],
    materialId: string | null,
    component: Component | undefined,
    session: YapcadViewerSessionSnapshotV1,
  ): Material | Material[] {
    const color = this.semanticColor(materialId, component, session);
    const convert = (source: Material) => {
      const result = source instanceof MeshStandardMaterial
        ? source.clone()
        : new MeshStandardMaterial({ color });
      result.color.set(color);
      result.metalness = component?.disposition === "buy" ? 0.62 : 0.08;
      result.roughness = component?.disposition === "buy" ? 0.34 : 0.58;
      result.side = DoubleSide;
      return result;
    };
    return Array.isArray(material) ? material.map(convert) : convert(material);
  }

  private semanticColor(
    materialId: string | null,
    component: Component | undefined,
    session: YapcadViewerSessionSnapshotV1,
  ): Color {
    const visual = materialId ? session.materials[materialId]?.visual : undefined;
    if (visual && typeof visual === "object" && "color" in visual) {
      const values = (visual as { color?: unknown }).color;
      if (Array.isArray(values) && values.length === 3 && values.every(Number.isFinite)) {
        return new Color(values[0] as number, values[1] as number, values[2] as number);
      }
    }
    if (component?.disposition === "buy") return new Color(0x8293a5);
    if (component?.disposition === "raw_stock") return new Color(0xb79562);
    return new Color(0x4aa8c7);
  }

  private highlight(partId: string, active: boolean): void {
    for (const mesh of this.partMeshes.get(partId) ?? []) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!(material instanceof MeshStandardMaterial)) continue;
        material.emissive.set(active ? 0x34d6d1 : 0x000000);
        material.emissiveIntensity = active ? 0.42 : 0;
      }
    }
  }

  private clearParts(): void {
    const geometries = new Set<BufferGeometry>();
    for (const group of this.partGroups.values()) {
      group.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        geometries.add(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      this.root.remove(group);
    }
    geometries.forEach((geometry) => geometry.dispose());
    this.partGroups.clear();
    this.partMeshes.clear();
    this.selectedPartId = null;
  }

  private resize(): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private animate = (): void => {
    this.frame = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerOrigin = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.pointerOrigin) return;
    const distance = Math.hypot(
      event.clientX - this.pointerOrigin.x,
      event.clientY - this.pointerOrigin.y,
    );
    this.pointerOrigin = null;
    if (distance > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [...this.partMeshes.values()].flat().filter((mesh) => {
      const partId = mesh.userData.partId as string | undefined;
      return mesh.visible && (!partId || this.partGroups.get(partId)?.visible !== false);
    });
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    this.setSelected(hit?.object.userData.partId ?? null, true);
  };
}
