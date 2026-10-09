/**
 * Procedural "clay" characters (Memoji-ish): rounded primitives on a soft
 * physical material, no assets. Built from parts, then each joint's static
 * parts are merged per material, so an avatar is ~20 draw calls. Joints are
 * plain groups that `poses.ts` rotates; hand props are toggled per action.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { Look } from "./identity";

export type Joints = {
  body: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  handL: THREE.Group;
  handR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  eyes: THREE.Mesh[];
};

/** Things an avatar can hold; only one per hand shows at a time. */
export type Props = {
  accessory: THREE.Group | null; // clipboard / magnifier, in the left hand
  envelope: THREE.Group;
  envelopeMat: THREE.MeshStandardMaterial;
  scroll: THREE.Group;
  flag: THREE.Group;
  flagMat: THREE.MeshStandardMaterial;
  block: THREE.Group;
  blockMat: THREE.MeshStandardMaterial;
  /** Idle props, right hand: a coffee mug, and a pencil to twirl. */
  mug: THREE.Group;
  pencil: THREE.Group;
};

export type Avatar = { root: THREE.Group; joints: Joints; props: Props };

// ── Shared geometry and materials ────────────────────────────────────────────

const SPHERE = new THREE.SphereGeometry(1, 40, 28);
const SPHERE_LO = new THREE.SphereGeometry(1, 20, 14);
const matCache = new Map<string, THREE.Material>();

function clay(color: string, kind: "clay" | "skin" | "hair" | "eye" | "metal" = "clay"): THREE.Material {
  const k = `${kind}:${color}`;
  let m = matCache.get(k);
  if (!m) {
    const base = { color, roughness: 0.58, clearcoat: 0.12, clearcoatRoughness: 0.5 };
    m =
      kind === "skin"
        ? new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.45, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color("#ff9c7a") })
        : kind === "hair"
          ? new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.45, clearcoat: 0.4 })
          : kind === "eye"
            ? new THREE.MeshPhysicalMaterial({ color, roughness: 0.08, clearcoat: 1 })
            : kind === "metal"
              ? new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.3 })
              : new THREE.MeshPhysicalMaterial(base);
    matCache.set(k, m);
  }
  return m;
}

type V3 = [number, number, number];

function part(geo: THREE.BufferGeometry, mat: THREE.Material, pos: V3 = [0, 0, 0], scale: V3 = [1, 1, 1], rot: V3 = [0, 0, 0]) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos);
  m.scale.set(...scale);
  m.rotation.set(...rot);
  m.castShadow = true;
  return m;
}

/** Deterministic PRNG, so an agent's hair is the same on every load. */
function rng(seed: string) {
  let s = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/**
 * Merge a group's direct mesh children per material into one mesh each (their
 * transforms baked in). Child groups (joints, props) are kept and merged in turn.
 * `keep` meshes stay separate (the eyes blink).
 */
function mergeGroup(g: THREE.Object3D, keep: Set<THREE.Object3D>) {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  for (const c of [...g.children]) {
    if (c instanceof THREE.Mesh && !keep.has(c)) {
      const list = byMat.get(c.material as THREE.Material) ?? [];
      list.push(c);
      byMat.set(c.material as THREE.Material, list);
    } else if (!(c instanceof THREE.Mesh)) mergeGroup(c, keep);
  }
  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => {
      m.updateMatrix();
      const geo = m.geometry.clone().applyMatrix4(m.matrix);
      for (const name of Object.keys(geo.attributes)) if (!["position", "normal", "uv"].includes(name)) geo.deleteAttribute(name);
      return geo;
    });
    const indexed = geos.every((x) => x.index);
    const merged = mergeGeometries(indexed ? geos : geos.map((x) => (x.index ? x.toNonIndexed() : x)));
    geos.forEach((x) => x.dispose());
    if (!merged) continue;
    for (const m of meshes) g.remove(m);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    g.add(mesh);
  }
}

// ── Builder ──────────────────────────────────────────────────────────────────

export function makeAvatar(look: Look, seed: string): Avatar {
  const M = {
    hoodie: clay(look.hoodie),
    trim: clay(look.trim),
    skin: clay(look.skin, "skin"),
    nose: clay(`#${new THREE.Color(look.skin).lerp(new THREE.Color("#ff6a4d"), 0.25).getHexString()}`, "skin"),
    hair: clay(look.hair, "hair"),
    eye: clay("#111014", "eye"),
    dark: clay("#1d1b20"),
    pants: clay("#2f3448"),
    shoe: clay("#f4f1ea"),
  };
  const root = new THREE.Group();
  const group = (parent: THREE.Object3D, pos: V3) => {
    const g = new THREE.Group();
    g.position.set(...pos);
    parent.add(g);
    return g;
  };

  // Legs and shoes.
  const legs: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const leg = group(root, [sx * 0.15, 0.5, 0]);
    leg.add(part(new THREE.CapsuleGeometry(0.13, 0.22, 6, 16), M.pants, [0, -0.22, 0]));
    leg.add(part(SPHERE_LO, M.shoe, [0, -0.43, 0.05], [0.15, 0.1, 0.22]));
    legs.push(leg);
  }

  // Torso: hoodie, waistband, hood collar, drawstrings.
  const body = group(root, [0, 0, 0]);
  body.add(part(new THREE.CapsuleGeometry(0.4, 0.38, 10, 32), M.hoodie, [0, 0.84, 0], [1, 1, 0.82]));
  body.add(part(new THREE.CylinderGeometry(0.41, 0.4, 0.15, 32), M.trim, [0, 0.66, 0], [1, 1, 0.83]));
  body.add(part(new THREE.TorusGeometry(0.19, 0.075, 14, 32), M.trim, [0, 1.21, 0.02], [1, 1, 0.9], [Math.PI / 2 - 0.15, 0, 0]));
  body.add(part(SPHERE_LO, M.trim, [0, 1.17, -0.17], [0.27, 0.16, 0.14]));
  for (const sx of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sx * 0.07, 1.19, 0.25),
      new THREE.Vector3(sx * 0.085, 1.05, 0.33),
      new THREE.Vector3(sx * 0.07, 0.9, 0.34),
    ]);
    body.add(part(new THREE.TubeGeometry(curve, 12, 0.012, 6), M.dark));
    body.add(part(new THREE.CapsuleGeometry(0.016, 0.03, 4, 8), M.trim, [sx * 0.07, 0.885, 0.34]));
  }

  // Arms (pivot at the shoulder), cuffs, hands.
  const arms: THREE.Group[] = [];
  const hands: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const arm = group(body, [sx * 0.4, 1.08, 0]);
    arm.add(part(new THREE.CapsuleGeometry(0.115, 0.3, 6, 16), M.hoodie, [0, -0.22, 0]));
    arm.add(part(new THREE.TorusGeometry(0.1, 0.035, 10, 20), M.trim, [0, -0.43, 0], [1, 1, 1], [Math.PI / 2, 0, 0]));
    const hand = group(arm, [0, -0.52, 0]);
    hand.add(part(SPHERE_LO, M.skin, [0, 0, 0], [0.095, 0.1, 0.085]));
    arms.push(arm);
    hands.push(hand);
  }

  // Neck and head.
  body.add(part(new THREE.CylinderGeometry(0.1, 0.11, 0.16, 16), M.skin, [0, 1.27, 0], [1, 1.3, 1]));
  const head = group(body, [0, 1.36, 0]);
  head.add(part(SPHERE, M.skin, [0, 0.5, 0], [0.5, 0.55, 0.47]));
  for (const sx of [-1, 1]) {
    head.add(part(SPHERE_LO, M.skin, [sx * 0.49, 0.48, -0.02], [0.06, 0.11, 0.085]));
    head.add(part(SPHERE_LO, M.nose, [sx * 0.515, 0.48, 0], [0.025, 0.07, 0.05]));
  }
  const eyes: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const eye = part(SPHERE_LO, M.eye, [sx * 0.165, 0.55, 0.415], [0.058, 0.075, 0.04]);
    head.add(eye);
    eyes.push(eye);
    head.add(part(new THREE.CapsuleGeometry(0.036, 0.14, 4, 12), M.hair, [sx * 0.18, 0.73, 0.4], [1, 1, 0.7], [0.15, -sx * 0.25, Math.PI / 2 + sx * 0.08]));
  }
  head.add(part(SPHERE_LO, M.nose, [0, 0.47, 0.47], [0.075, 0.06, 0.06]));
  head.add(part(new THREE.TorusGeometry(0.11, 0.009, 6, 24, Math.PI * 0.42), M.dark, [0, 0.415, 0.445], [1, 0.75, 1], [-0.25, 0, -Math.PI * 0.71]));

  // Hair.
  const r = rng(seed);
  const cap = (top: number) =>
    part(new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI * top), M.hair, [0, 0.54, -0.03], [0.53, 0.56, 0.5], [-0.32, 0, 0]);
  const tufts = (n: number, spiky: boolean) => {
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const rad = 0.12 + r() * 0.26;
      const x = Math.cos(a) * rad * 1.15;
      const z = Math.sin(a) * rad * 0.9 + 0.02;
      const y = 0.98 + (0.3 - rad) * 0.35 + r() * 0.05 + (z > 0.12 ? 0.04 : 0);
      head.add(
        part(new THREE.CapsuleGeometry(spiky ? 0.06 : 0.1 + r() * 0.035, spiky ? 0.2 : 0.08 + r() * 0.06, 4, 10), M.hair, [x, y, z], [1, 1, 0.8], [
          (spiky ? 0.2 : 0.5) + z * 1.2 + (r() - 0.5) * 0.6,
          r() * Math.PI,
          -x * 1.6 + (r() - 0.5) * 0.5,
        ]),
      );
    }
  };
  switch (look.hairStyle) {
    case "quiff":
    case "spiky":
      head.add(cap(0.44));
      for (const sx of [-1, 1]) head.add(part(SPHERE_LO, M.hair, [sx * 0.42, 0.66, -0.08], [0.12, 0.2, 0.3]));
      tufts(look.hairStyle === "spiky" ? 26 : 38, look.hairStyle === "spiky");
      break;
    case "bun":
      head.add(cap(0.5));
      head.add(part(SPHERE_LO, M.hair, [0, 1.12, -0.18], [0.17, 0.16, 0.17]));
      break;
    case "bob":
      head.add(cap(0.5));
      for (const sx of [-1, 1]) head.add(part(SPHERE_LO, M.hair, [sx * 0.42, 0.48, -0.06], [0.16, 0.36, 0.38]));
      head.add(part(SPHERE_LO, M.hair, [0, 0.5, -0.2], [0.5, 0.42, 0.33]));
      head.add(part(SPHERE_LO, M.hair, [0, 0.9, 0.3], [0.38, 0.12, 0.16], [0.4, 0, 0])); // fringe
      break;
    default:
      head.add(cap(0.42));
  }

  // Head accessories (merged with the head) and the left-hand item.
  let accessory: THREE.Group | null = null;
  switch (look.accessory) {
    case "glasses":
      for (const sx of [-1, 1]) head.add(part(new THREE.TorusGeometry(0.095, 0.014, 6, 24), M.dark, [sx * 0.165, 0.55, 0.45]));
      head.add(part(new THREE.CylinderGeometry(0.01, 0.01, 0.1, 6), M.dark, [0, 0.56, 0.46], [1, 1, 1], [0, 0, Math.PI / 2]));
      break;
    case "headset":
      head.add(part(new THREE.TorusGeometry(0.54, 0.028, 8, 40, Math.PI), M.dark, [0, 0.5, 0], [1, 1.07, 1]));
      for (const sx of [-1, 1]) head.add(part(SPHERE_LO, M.trim, [sx * 0.54, 0.5, 0], [0.07, 0.12, 0.12]));
      head.add(part(new THREE.CapsuleGeometry(0.015, 0.3, 4, 8), M.dark, [-0.42, 0.36, 0.22], [1, 1, 1], [0.9, 0.6, 0.5]));
      break;
    case "bow":
      for (const sx of [-1, 1]) head.add(part(new THREE.ConeGeometry(0.1, 0.18, 12), M.trim, [0.3 + sx * 0.09, 1.0, 0.05], [1, 1, 0.6], [0, 0, sx * Math.PI / 2]));
      head.add(part(SPHERE_LO, M.trim, [0.3, 1.0, 0.05], [0.05, 0.05, 0.05]));
      break;
    case "cap":
      head.add(part(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), M.hoodie, [0, 0.66, -0.02], [0.54, 0.46, 0.52], [-0.15, 0, 0]));
      head.add(part(new THREE.CylinderGeometry(0.3, 0.3, 0.025, 24, 1, false, -Math.PI / 2, Math.PI), M.trim, [0, 0.72, 0.3], [1, 1, 1.2], [0.15, 0, 0]));
      head.add(part(SPHERE_LO, M.trim, [0, 1.12, 0], [0.04, 0.04, 0.04]));
      break;
    case "beanie":
      head.add(part(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), M.trim, [0, 0.66, -0.02], [0.56, 0.52, 0.53], [-0.2, 0, 0]));
      head.add(part(new THREE.TorusGeometry(0.5, 0.06, 8, 32), M.trim, [0, 0.68, 0], [1, 1, 0.94], [Math.PI / 2 - 0.2, 0, 0]));
      head.add(part(SPHERE_LO, M.trim, [0, 1.2, -0.12], [0.09, 0.09, 0.09]));
      break;
    case "clipboard": {
      accessory = new THREE.Group();
      accessory.add(part(new RoundedBoxGeometry(0.3, 0.38, 0.025, 2, 0.02), clay("#b07a4a")));
      accessory.add(part(new RoundedBoxGeometry(0.25, 0.3, 0.01, 1, 0.004), clay("#fbfaf6"), [0, -0.02, 0.016]));
      accessory.add(part(new RoundedBoxGeometry(0.12, 0.05, 0.035, 2, 0.012), clay("#c9ccd4", "metal"), [0, 0.18, 0.015]));
      for (let i = 0; i < 4; i++)
        accessory.add(part(new THREE.BoxGeometry(i === 0 ? 0.16 : 0.19, 0.012, 0.004), clay(i === 0 ? look.hoodie : "#9aa0ad"), [-0.01, 0.08 - i * 0.055, 0.023]));
      accessory.position.set(0.02, 0.05, 0.12);
      accessory.rotation.set(-0.3, 0.5, 0.15);
      break;
    }
    case "magnifier": {
      accessory = new THREE.Group();
      accessory.add(part(new THREE.CylinderGeometry(0.025, 0.03, 0.22, 10), clay("#7c4a2a"), [0, 0.02, 0]));
      accessory.add(part(new THREE.TorusGeometry(0.1, 0.022, 8, 24), clay("#c9ccd4", "metal"), [0, 0.24, 0]));
      const glass = new THREE.MeshPhysicalMaterial({ color: "#bfe8ff", transparent: true, opacity: 0.35, roughness: 0.05 });
      accessory.add(part(new THREE.CylinderGeometry(0.09, 0.09, 0.01, 20), glass, [0, 0.24, 0], [1, 1, 1], [Math.PI / 2, 0, 0]));
      accessory.position.set(0, 0.03, 0.06);
      accessory.rotation.set(-0.2, 0, -0.3);
      break;
    }
  }
  if (accessory) hands[0].add(accessory);

  // Action props (right hand unless noted).
  const glow = (c: string) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.2, roughness: 0.4 });
  const envelopeMat = glow("#e879f9");
  const envelope = new THREE.Group();
  envelope.add(part(new RoundedBoxGeometry(0.34, 0.22, 0.03, 2, 0.01), envelopeMat));
  envelope.add(part(new THREE.ConeGeometry(0.17, 0.1, 3), clay("#fffdf7"), [0, 0.05, 0.02], [1, 1, 0.1], [0, 0, Math.PI]));
  envelope.position.set(0, -0.14, 0.06);

  const scroll = new THREE.Group();
  scroll.add(part(new RoundedBoxGeometry(0.32, 0.4, 0.015, 1, 0.005), clay("#f3e7c9")));
  for (const sy of [-1, 1]) scroll.add(part(new THREE.CylinderGeometry(0.025, 0.025, 0.36, 10), clay("#b07a4a"), [0, sy * 0.2, 0], [1, 1, 1], [0, 0, Math.PI / 2]));
  for (let i = 0; i < 4; i++) scroll.add(part(new THREE.BoxGeometry(0.2, 0.012, 0.004), clay("#9aa0ad"), [0, 0.1 - i * 0.06, 0.01]));
  scroll.position.set(-0.2, 0.15, 0.15);
  scroll.rotation.set(-0.5, 0, 0);

  const flagMat = glow(look.hoodie);
  flagMat.emissiveIntensity = 0.4;
  const flag = new THREE.Group();
  flag.add(part(new THREE.CylinderGeometry(0.015, 0.015, 0.9, 8), clay("#e2e8f0"), [0, -0.3, 0]));
  flag.add(part(new THREE.BoxGeometry(0.3, 0.18, 0.01), flagMat, [0.15, -0.65, 0]));

  const blockMat = glow(look.hoodie);
  blockMat.emissiveIntensity = 0.5;
  const block = new THREE.Group();
  block.add(part(new RoundedBoxGeometry(0.4, 0.22, 0.4, 2, 0.04), blockMat));
  block.position.set(-0.25, -0.16, 0);

  // Upright when the forearm is raised to the chest (arm ≈ -1.2 rad); tips when lifted to drink.
  const mug = new THREE.Group();
  mug.add(part(new THREE.CylinderGeometry(0.1, 0.09, 0.2, 16), clay(look.trim), [0, 0, 0]));
  mug.add(part(new THREE.TorusGeometry(0.06, 0.018, 8, 16), clay(look.trim), [0.11, 0, 0], [1, 1, 1], [0, 0, Math.PI / 2]));
  mug.add(part(new THREE.CylinderGeometry(0.085, 0.085, 0.01, 16), clay("#3b2414"), [0, 0.09, 0]));
  mug.position.set(0, -0.06, 0.1);
  mug.rotation.x = 1.2;

  const pencil = new THREE.Group();
  const lead = new THREE.Group();
  lead.add(part(new THREE.CylinderGeometry(0.016, 0.016, 0.34, 6), clay("#facc15")));
  lead.add(part(new THREE.ConeGeometry(0.016, 0.06, 6), clay("#f1c7a5"), [0, 0.2, 0]));
  lead.add(part(new THREE.CylinderGeometry(0.017, 0.017, 0.04, 6), clay("#f472b6"), [0, -0.19, 0]));
  lead.rotation.x = Math.PI / 2; // lies across the fingers; the group spins it
  pencil.add(lead);
  pencil.scale.setScalar(1.6); // reads at desk distance
  pencil.position.set(0, -0.05, 0.08);

  for (const p of [envelope, scroll, flag, block, mug, pencil]) {
    p.visible = false;
    hands[1].add(p);
  }

  mergeGroup(root, new Set(eyes));
  root.traverse((o) => (o.matrixAutoUpdate = true));
  return {
    root,
    joints: { body, head, armL: arms[0], armR: arms[1], handL: hands[0], handR: hands[1], legL: legs[0], legR: legs[1], eyes },
    props: { accessory, envelope, envelopeMat, scroll, flag, flagMat, block, blockMat, mug, pencil },
  };
}

/** Free an avatar's own (non-shared) GPU resources. */
export function disposeAvatar(a: Avatar) {
  a.root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.geometry !== SPHERE && o.geometry !== SPHERE_LO) o.geometry.dispose();
  });
  a.props.envelopeMat.dispose();
  a.props.flagMat.dispose();
  a.props.blockMat.dispose();
}
