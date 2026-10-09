"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as THREE from "three";

const v = new THREE.Vector3();

/**
 * HTML pinned to a point in the 3D scene, like drei's <Html> (which this
 * replaces for Agents City's labels). DOM can't live in the three.js tree, so
 * each label renders into its own React root in an element over the canvas,
 * moved every frame to the point's screen position.
 *
 * Two things differ from drei's version:
 * - the root is unmounted after the current React work finishes, not inside
 *   the effect cleanup: unmounting a root synchronously while React is
 *   rendering warns ("Attempted to synchronously unmount a root…"), and
 *   StrictMode does exactly that once per label in development;
 * - the element is removed only if it is still attached, so a double cleanup
 *   (StrictMode, a fast remount) can't throw "removeChild … not a child".
 */
export function OverlayLabel({
  children,
  position,
  center = false,
  zIndexRange = [16777271, 0],
  style,
}: {
  children: ReactNode;
  position?: [number, number, number];
  center?: boolean;
  /** z-index for the nearest and farthest labels (nearer ones on top). */
  zIndexRange?: [number, number];
  style?: CSSProperties;
}) {
  const group = useRef<THREE.Group>(null);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const connected = useThree((s) => s.events.connected) as HTMLElement | undefined;
  const elRef = useRef<HTMLDivElement | null>(null);
  const root = useRef<Root | null>(null);
  const target = connected ?? (gl.domElement.parentNode as HTMLElement | null);

  useLayoutEffect(() => {
    if (!target) return;
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;top:0;left:0;will-change:transform;display:none;";
    const r = createRoot(el);
    elRef.current = el;
    root.current = r;
    target.appendChild(el);
    return () => {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (elRef.current === el) elRef.current = null;
      if (root.current === r) root.current = null;
      setTimeout(() => r.unmount(), 0);
    };
  }, [target]);

  const inner = useMemo<CSSProperties>(
    () => ({ position: "absolute", transform: center ? "translate3d(-50%,-50%,0)" : "none", ...style }),
    [center, style],
  );
  useLayoutEffect(() => {
    root.current?.render(<div style={inner}>{children}</div>);
  });

  useFrame(() => {
    const g = group.current;
    const el = elRef.current;
    if (!g || !el) return;
    v.setFromMatrixPosition(g.matrixWorld);
    const dist = camera.position.distanceTo(v);
    v.project(camera);
    // Behind the camera (or past the far plane): hide.
    if (v.z < -1 || v.z > 1) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    const x = (v.x * 0.5 + 0.5) * size.width;
    const y = (-v.y * 0.5 + 0.5) * size.height;
    el.style.transform = `translate3d(${x}px,${y}px,0)`;
    const far = (camera as THREE.PerspectiveCamera).far || 1000;
    const [near, farZ] = zIndexRange;
    el.style.zIndex = String(Math.round(near - (near - farZ) * Math.min(1, dist / far)));
  });

  return <group ref={group} position={position} />;
}
