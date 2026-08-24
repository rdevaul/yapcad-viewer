import {
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  Light,
} from "three";

export type LightingPresetName = "studio" | "inspection" | "flat";

export const lightingPresets: Record<
  LightingPresetName,
  { label: string; description: string }
> = {
  studio: { label: "Studio", description: "Balanced three-point lighting" },
  inspection: { label: "Inspection", description: "High-contrast surface lighting" },
  flat: { label: "Flat", description: "Even documentation lighting" },
};

export function createLights(preset: LightingPresetName): Light[] {
  if (preset === "flat") {
    const key = new DirectionalLight(0xffffff, 1.2);
    key.position.set(0.2, -0.5, 1);
    return [new AmbientLight(0xffffff, 1.8), key];
  }
  if (preset === "inspection") {
    const key = new DirectionalLight(0xffffff, 4.2);
    key.position.set(1, -1.5, 2);
    const rim = new DirectionalLight(0x4cc9f0, 2.1);
    rim.position.set(-1.5, 1, 0.4);
    return [new AmbientLight(0x1b2230, 0.8), key, rim];
  }
  const key = new DirectionalLight(0xffffff, 3.2);
  key.position.set(1.2, -1.5, 2);
  const fill = new DirectionalLight(0x8db8ff, 1.5);
  fill.position.set(-1.5, -0.5, 0.8);
  const rim = new DirectionalLight(0xffc28a, 1.1);
  rim.position.set(0.2, 1.5, 1);
  return [new HemisphereLight(0xb8d9ff, 0x18202c, 1.3), key, fill, rim];
}
