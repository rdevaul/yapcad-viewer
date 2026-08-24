"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { YapcadViewerDerivedSceneV1 } from "@/src/contracts/scene-v1";
import type {
  Component,
  Part,
  YapcadViewerSessionSnapshotV1,
} from "@/src/contracts/session-v1";
import {
  dispositionLabels,
  partDepth,
  partIdsByDisposition,
  shortDigest,
  type Disposition,
} from "@/src/lib/semantics";
import { createViewerApi } from "@/src/lib/viewer-api";
import type {
  SceneViewer,
  ClipAxis,
  RenderMode,
  StandardView,
} from "@/src/viewer/SceneViewer";
import {
  lightingPresets,
  type LightingPresetName,
} from "@/src/viewer/lighting";

type LoadState = "loading" | "ready" | "error";
type ClipState = Record<ClipAxis, { enabled: boolean; position: number; inverted: boolean }>;

const defaultClipping: ClipState = {
  x: { enabled: false, position: 0.5, inverted: false },
  y: { enabled: false, position: 0.5, inverted: false },
  z: { enabled: false, position: 0.5, inverted: false },
};

export function ViewerWorkbench() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<SceneViewer | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadMessage, setLoadMessage] = useState("Opening engineering package…");
  const [session, setSession] = useState<YapcadViewerSessionSnapshotV1 | null>(null);
  const [scene, setScene] = useState<YapcadViewerDerivedSceneV1 | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<RenderMode>("solid");
  const [lighting, setLighting] = useState<LightingPresetName>("studio");
  const [clipping, setClipping] = useState<ClipState>(defaultClipping);
  const [showClipping, setShowClipping] = useState(false);
  const [visibleGroups, setVisibleGroups] = useState<Record<Disposition, boolean>>({
    make: true,
    buy: true,
    raw_stock: true,
    consumable: true,
  });

  useEffect(() => {
    if (!viewportRef.current) return;
    const container = viewportRef.current;
    let viewer: SceneViewer | null = null;
    let active = true;
    const api = createViewerApi(window.location.search);
    import("@/src/viewer/SceneViewer")
      .then(({ SceneViewer: Viewer }) => {
        if (!active) return null;
        viewer = new Viewer(container, { onSelect: setSelectedPartId });
        viewerRef.current = viewer;
        return api.loadInitial();
      })
      .then(async (initial) => {
        if (!active || !initial || !viewer) return;
        setLoadMessage("Tessellating semantic scene…");
        await viewer.load(initial.session, initial.scene, api);
        if (!active) return;
        setSession(initial.session);
        setScene(initial.scene);
        const initialSelection = initial.session.selection[0] ?? null;
        setSelectedPartId(initialSelection);
        viewer.setSelected(initialSelection);
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadState("error");
        setLoadMessage(error instanceof Error ? error.message : "Unable to open scene");
      });
    return () => {
      active = false;
      viewer?.dispose();
      viewerRef.current = null;
    };
  }, []);

  const componentById = useMemo(
    () => new Map(session?.components.map((item) => [item.id, item]) ?? []),
    [session],
  );
  const selectedPart = session?.parts.find((item) => item.id === selectedPartId) ?? null;
  const selectedComponent = selectedPart
    ? componentById.get(selectedPart.componentId) ?? null
    : null;
  const dispositionParts = session ? partIdsByDisposition(session) : null;

  const selectPart = (partId: string | null) => {
    setSelectedPartId(partId);
    viewerRef.current?.setSelected(partId);
  };

  const setGroupVisibility = (disposition: Disposition, visible: boolean) => {
    setVisibleGroups((current) => ({ ...current, [disposition]: visible }));
    viewerRef.current?.setPartsVisible(dispositionParts?.[disposition] ?? [], visible);
  };

  const updateClip = (
    axis: ClipAxis,
    update: Partial<ClipState[ClipAxis]>,
  ) => {
    setClipping((current) => {
      const next = { ...current, [axis]: { ...current[axis], ...update } };
      const value = next[axis];
      viewerRef.current?.setClipPlane(axis, value.enabled, value.position, value.inverted);
      return next;
    });
  };

  return (
    <main className="workbench-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">yC</span>
          <div>
            <strong>yapCAD Viewer</strong>
            <span>semantic package inspection</span>
          </div>
        </div>
        <div className="package-heading">
          <span className="eyebrow">OPEN PACKAGE</span>
          <strong>{session?.package.name ?? "YapRover prototype"}</strong>
          <span>v{session?.package.version ?? "0.1.0"}</span>
        </div>
        <div className="topbar-status">
          <span className={`status-dot ${loadState}`} />
          <span>{loadState === "ready" ? `revision ${session?.revision}` : loadState}</span>
          {session && <code>{shortDigest(session.package.digest)}</code>}
        </div>
      </header>

      <aside className="assembly-panel panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">PRODUCT TREE</span>
            <h2>Assembly</h2>
          </div>
          <span className="count-badge">{session?.parts.length ?? 0}</span>
        </div>
        <div className="tree-list" role="tree" aria-label="Assembly parts">
          {session?.parts.map((part) => (
            <PartRow
              key={part.id}
              part={part}
              component={componentById.get(part.componentId)}
              depth={partDepth(part, session.parts)}
              selected={part.id === selectedPartId}
              onSelect={() => selectPart(part.id)}
            />
          ))}
        </div>
        <div className="visibility-groups">
          <span className="eyebrow">VISIBILITY GROUPS</span>
          {(Object.keys(dispositionLabels) as Disposition[]).map((disposition) => {
            const count = dispositionParts?.[disposition].length ?? 0;
            if (!count) return null;
            return (
              <label key={disposition} className="visibility-row">
                <input
                  type="checkbox"
                  checked={visibleGroups[disposition]}
                  onChange={(event) => setGroupVisibility(disposition, event.target.checked)}
                />
                <span className={`group-swatch ${disposition}`} />
                <span>{dispositionLabels[disposition]}</span>
                <small>{count}</small>
              </label>
            );
          })}
        </div>
      </aside>

      <section className="viewport-panel" aria-label="3D package viewport">
        <div className="viewport-toolbar floating-panel">
          <div className="segmented" aria-label="Render mode">
            {(["solid", "wireframe", "xray"] as RenderMode[]).map((mode) => (
              <button
                key={mode}
                className={renderMode === mode ? "active" : ""}
                onClick={() => {
                  setRenderMode(mode);
                  viewerRef.current?.setRenderMode(mode);
                }}
              >
                {mode === "wireframe" ? "Wire" : mode[0].toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
          <select
            aria-label="Lighting preset"
            value={lighting}
            onChange={(event) => {
              const preset = event.target.value as LightingPresetName;
              setLighting(preset);
              viewerRef.current?.setLighting(preset);
            }}
          >
            {(Object.keys(lightingPresets) as LightingPresetName[]).map((name) => (
              <option key={name} value={name}>{lightingPresets[name].label}</option>
            ))}
          </select>
          <button className={showClipping ? "active" : ""} onClick={() => setShowClipping(!showClipping)}>
            Section
          </button>
          <button onClick={() => viewerRef.current?.fitToView()}>Fit</button>
        </div>

        <div className="view-cube floating-panel" aria-label="Standard views">
          {(["isometric", "front", "right", "top"] as StandardView[]).map((view) => (
            <button key={view} onClick={() => viewerRef.current?.setStandardView(view)}>
              {view === "isometric" ? "ISO" : view.slice(0, 1).toUpperCase()}
            </button>
          ))}
        </div>

        {showClipping && (
          <div className="clipping-popover floating-panel">
            <div className="popover-heading">
              <strong>Section planes</strong>
              <button onClick={() => {
                setClipping(defaultClipping);
                (Object.keys(defaultClipping) as ClipAxis[]).forEach((axis) =>
                  viewerRef.current?.setClipPlane(axis, false, 0.5, false));
              }}>Reset</button>
            </div>
            {(Object.keys(clipping) as ClipAxis[]).map((axis) => (
              <div className="clip-row" key={axis}>
                <label>
                  <input
                    type="checkbox"
                    checked={clipping[axis].enabled}
                    onChange={(event) => updateClip(axis, { enabled: event.target.checked })}
                  />
                  <span className={`axis-label ${axis}`}>{axis.toUpperCase()}</span>
                </label>
                <input
                  aria-label={`${axis.toUpperCase()} section position`}
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={clipping[axis].position}
                  disabled={!clipping[axis].enabled}
                  onChange={(event) => updateClip(axis, { position: Number(event.target.value) })}
                />
                <button
                  className={clipping[axis].inverted ? "active" : ""}
                  disabled={!clipping[axis].enabled}
                  onClick={() => updateClip(axis, { inverted: !clipping[axis].inverted })}
                >
                  Flip
                </button>
              </div>
            ))}
          </div>
        )}

        <div ref={viewportRef} className="three-viewport" />
        {loadState !== "ready" && (
          <div className={`loading-state ${loadState}`} role="status">
            <span className="loader-ring" />
            <strong>{loadState === "error" ? "Scene unavailable" : "Preparing viewport"}</strong>
            <p>{loadMessage}</p>
          </div>
        )}
        <div className="viewport-caption">
          <span>{scene?.units ?? "millimetre"}</span>
          <span>•</span>
          <span>{scene?.assets.filter((asset) => asset.sourceRepresentation === "brep").length ?? 0} analytic BREP assets</span>
          <span>•</span>
          <span>drag to orbit · scroll to zoom · click to inspect</span>
        </div>
      </section>

      <aside className="inspector-panel panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">INSPECTOR</span>
            <h2>{selectedPart ? "Part instance" : "Package"}</h2>
          </div>
          {selectedPart && <button className="quiet-button" onClick={() => selectPart(null)}>Clear</button>}
        </div>
        {selectedPart && selectedComponent ? (
          <PartInspector
            part={selectedPart}
            component={selectedComponent}
            session={session!}
          />
        ) : (
          <PackageInspector session={session} scene={scene} />
        )}
      </aside>
    </main>
  );
}

function PartRow({
  part,
  component,
  depth,
  selected,
  onSelect,
}: {
  part: Part;
  component?: Component;
  depth: number;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      role="treeitem"
      aria-selected={selected}
      className={`part-row ${selected ? "selected" : ""}`}
      style={{ paddingLeft: `${14 + depth * 16}px` }}
      onClick={onSelect}
    >
      <span className={`part-icon ${component?.disposition ?? "make"}`} />
      <span className="part-title">
        <strong>{part.name}</strong>
        <small>{component?.name ?? part.componentId}</small>
      </span>
    </button>
  );
}

function PartInspector({
  part,
  component,
  session,
}: {
  part: Part;
  component: Component;
  session: YapcadViewerSessionSnapshotV1;
}) {
  const bom = session.bom.items.find((item) => item.componentId === component.id);
  return (
    <div className="inspector-content">
      <div className="hero-part-card">
        <span className={`disposition-pill ${component.disposition}`}>
          {dispositionLabels[component.disposition]}
        </span>
        <h3>{part.name}</h3>
        <p>{component.description || component.name}</p>
      </div>
      <DefinitionList rows={[
        ["Instance ID", part.id],
        ["Component", component.id],
        ["Part number", component.partNumber ?? "—"],
        ["Revision", component.revision ?? "—"],
        ["Material", part.materialId ?? component.materialId ?? "Unspecified"],
        ["BOM quantity", bom ? `${bom.quantity} ${bom.unit}` : "—"],
      ]} />
      <section className="inspector-section">
        <div className="section-title"><span>Datums</span><small>{part.datums.length}</small></div>
        {part.datums.length ? part.datums.map((datum) => (
          <div className="datum-row" key={datum.id}>
            <span className="datum-glyph">⌖</span>
            <div><strong>{datum.id}</strong><small>{datum.kind}</small></div>
            <code>{datum.origin.map((value) => value.toFixed(1)).join(" · ")}</code>
          </div>
        )) : <p className="empty-copy">No declared datums.</p>}
      </section>
      <section className="inspector-section">
        <div className="section-title"><span>Geometry authority</span></div>
        <code className="digest-block">{component.assetDigest ?? "No geometry digest"}</code>
      </section>
    </div>
  );
}

function PackageInspector({
  session,
  scene,
}: {
  session: YapcadViewerSessionSnapshotV1 | null;
  scene: YapcadViewerDerivedSceneV1 | null;
}) {
  const makeCount = session?.components.filter((item) => item.disposition === "make").length ?? 0;
  const buyCount = session?.components.filter((item) => item.disposition === "buy").length ?? 0;
  return (
    <div className="inspector-content">
      <div className="package-summary">
        <span className="validity-mark">✓</span>
        <div><strong>Package validated</strong><small>authoritative content unchanged</small></div>
      </div>
      <div className="metric-grid">
        <div><strong>{session?.parts.length ?? 0}</strong><span>instances</span></div>
        <div><strong>{scene?.assets.length ?? 0}</strong><span>mesh assets</span></div>
        <div><strong>{makeCount}</strong><span>fabricated</span></div>
        <div><strong>{buyCount}</strong><span>COTS</span></div>
      </div>
      <section className="inspector-section">
        <div className="section-title"><span>Validation</span></div>
        {session?.validation.warnings.length ? session.validation.warnings.map((warning) => (
          <p key={warning.message} className="warning-copy">{warning.message}</p>
        )) : <p className="empty-copy">No package warnings.</p>}
      </section>
      <section className="inspector-section">
        <div className="section-title"><span>Scene identity</span></div>
        <code className="digest-block">{scene?.digest ?? "Waiting for scene…"}</code>
      </section>
    </div>
  );
}

function DefinitionList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="definition-list">
      {rows.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}
