/**
 * A comic thought cloud: a puffy cloud joined to the head by three shrinking
 * puffs, with three dots inside that pulse in turn. It drifts and breathes like
 * the mug's steam, and fades in and out with `alpha`. Plain three.js, in
 * avatar units (scale it with the avatar).
 */
import * as THREE from "three";

const SPHERE = new THREE.SphereGeometry(1, 20, 14);
/** Seconds for a full fade in or out, on the wall clock (not the capped frame step). */
const FADE_S = 0.6;

export type ThoughtCloud = {
  group: THREE.Group;
  /** Show it (1) or hide it (0); faded linearly over `FADE_S` by `update`. */
  target: number;
  /** Still fading in or out (frames on demand: keep asking while it does). */
  readonly fading: boolean;
  update: (t: number, dt: number, still: boolean) => void;
  dispose: () => void;
};

export function makeThoughtCloud(): ThoughtCloud {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, emissive: "#e2e8f0", emissiveIntensity: 0.35, transparent: true, opacity: 0, depthWrite: false });
  const dotMat = new THREE.MeshBasicMaterial({ color: "#475569", transparent: true, opacity: 0 });
  const blob = (x: number, y: number, r: number, m = mat) => {
    const s = new THREE.Mesh(SPHERE, m);
    s.position.set(x, y, 0);
    s.scale.setScalar(r);
    group.add(s);
    return s;
  };
  // The trail of puffs rising from the head, then the cloud.
  const puffs = [blob(0.05, 0.0, 0.07), blob(0.16, 0.2, 0.1), blob(0.3, 0.44, 0.14)];
  const cloud = new THREE.Group();
  cloud.position.set(0.5, 0.95, 0);
  group.add(cloud);
  for (const [x, y, r] of [
    [0, 0, 0.32],
    [-0.3, -0.04, 0.24],
    [0.3, -0.04, 0.24],
    [-0.15, 0.18, 0.24],
    [0.17, 0.18, 0.25],
    [0, -0.12, 0.26],
  ]) {
    const s = new THREE.Mesh(SPHERE, mat);
    s.position.set(x, y, 0);
    s.scale.set(r * 1.25, r, r * 0.7);
    cloud.add(s);
  }
  const dots = [-0.18, 0, 0.18].map((x) => {
    const d = new THREE.Mesh(SPHERE, dotMat.clone());
    d.position.set(x, 0, 0.26);
    d.scale.setScalar(0.055);
    cloud.add(d);
    return d;
  });

  let alpha = 0;
  let last = performance.now();
  const api: ThoughtCloud = {
    group,
    target: 0,
    get fading() {
      return alpha !== api.target;
    },
    update(t, _dt, still) {
      // Linear on real time: `dt` is capped at 0.1 s per frame, so at a low frame
      // rate a frame-step fade would drag on for seconds.
      const now = performance.now();
      const step = (now - last) / 1000 / FADE_S;
      last = now;
      alpha = api.target > alpha ? Math.min(api.target, alpha + step) : Math.max(api.target, alpha - step);
      group.visible = alpha > 0;
      if (!group.visible) return;
      const breathe = still ? 1 : 0.88 + 0.12 * Math.sin(t * 1.3);
      mat.opacity = 0.92 * alpha * breathe;
      // Drift: the cloud bobs and sways gently; the puffs follow, out of phase.
      cloud.position.y = 0.95 + (still ? 0 : Math.sin(t * 0.8) * 0.06);
      cloud.position.x = 0.5 + (still ? 0 : Math.sin(t * 0.5) * 0.04);
      puffs.forEach((p, i) => (p.position.y = [0, 0.2, 0.44][i] + (still ? 0 : Math.sin(t * 1.1 + i) * 0.025)));
      // "…": the dots light up in turn.
      dots.forEach((d, i) => {
        const on = still ? 1 : 0.35 + 0.65 * Math.max(0, Math.sin(t * 4 - i * 0.9));
        (d.material as THREE.MeshBasicMaterial).opacity = alpha * on;
      });
    },
    dispose() {
      mat.dispose();
      dotMat.dispose();
      dots.forEach((d) => (d.material as THREE.Material).dispose());
    },
  };
  return api;
}
