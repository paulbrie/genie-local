/**
 * The seated agent in the Ops view (T202), built of isometric boxes like the cities' blocks: head, torso, pelvis,
 * upper arms, forearms, hands, thighs, shins and feet, each a box along its bone, seen from the same side as the map
 * and shaded as its blocks are (the top lightest, the face towards +z darker, the face towards +x darker still).
 * Pure: a pose's bones in the desk's own frame (desks.ts: x along the desk, z towards the agent, h up, the seat at the
 * origin; the agent faces −z, the desk and its computer), and each bone's visible faces, back to front.
 */

export type V3 = { x: number; h: number; z: number };
/** the desk's poses, and the cafeteria's (T210): sitting at the table with a coffee, or sipping it */
export type Doing = "type" | "read" | "run" | "think" | "wait" | "idle" | "nap" | "cafe" | "sip";
/** what a bone is made of: the shirt (the agent's colour), the trousers (its colour, darker), skin, hair, shoes, a cup */
export type Stuff = "shirt" | "pants" | "skin" | "hair" | "shoe" | "cup";
/** a bone: a box from `a` to `b`, `w` across (along `side`, near x) and `t` thick */
export type Bone = { name: string; a: V3; b: V3; w: number; t: number; stuff: Stuff; side?: V3 };

const v = (x: number, h: number, z: number): V3 => ({ x, h, z });
const add = (p: V3, q: V3): V3 => v(p.x + q.x, p.h + q.h, p.z + q.z);
const sub = (p: V3, q: V3): V3 => v(p.x - q.x, p.h - q.h, p.z - q.z);
const mul = (p: V3, k: number): V3 => v(p.x * k, p.h * k, p.z * k);
const dot = (p: V3, q: V3) => p.x * q.x + p.h * q.h + p.z * q.z;
const cross = (p: V3, q: V3): V3 => v(p.h * q.z - p.z * q.h, p.z * q.x - p.x * q.z, p.x * q.h - p.h * q.x);
const norm = (p: V3) => { const l = Math.hypot(p.x, p.h, p.z) || 1; return mul(p, 1 / l); };

/** where the viewer is (in this projection, moving along this changes nothing on screen): faces towards it show */
export const VIEW = norm(v(1, 1, 1));
/** nearer the viewer, drawn later */
export const depth = (p: V3) => p.x + p.h + p.z;

/** a pose's joints: the hips, the neck, each side's shoulder, elbow, hand, knee and foot (k = −1 left, 1 right) */
type Joints = { hip: V3; neck: V3; elbow: [V3, V3]; hand: [V3, V3]; knee: [V3, V3]; foot: [V3, V3]; /** the way the face looks */ facing: 1 | -1 };

const KEYS_H = 2.72, KEYS_Z = -1.85;
function joints(doing: Doing): Joints {
  const hip = v(0, 1.55, 0.15);
  // (seated at the desk: knees under it, feet on the ground)
  const legs = { knee: [v(-0.45, 1.45, -0.95), v(0.45, 1.45, -0.95)] as [V3, V3], foot: [v(-0.45, 0.12, -1.15), v(0.45, 0.12, -1.15)] as [V3, V3] };
  switch (doing) {
    case "type":
      return { hip, neck: v(0, 3.5, -0.15), elbow: [v(-0.85, 2.65, -0.75), v(0.85, 2.65, -0.75)], hand: [v(-0.45, KEYS_H, KEYS_Z), v(0.45, KEYS_H, KEYS_Z)], ...legs, facing: -1 };
    case "read":
      // (leaning in, the right hand on the mouse, the left on the desk's edge)
      return { hip, neck: v(0, 3.45, -0.45), elbow: [v(-0.85, 2.7, -0.9), v(0.95, 2.7, -1.0)], hand: [v(-0.6, KEYS_H, -1.6), v(1.25, KEYS_H, -1.9)], ...legs, facing: -1 };
    case "run":
      // (hands off the keys, in the lap, watching the screen)
      return { hip, neck: v(0, 3.55, 0.05), elbow: [v(-0.85, 2.3, -0.05), v(0.85, 2.3, -0.05)], hand: [v(-0.3, 1.85, -0.75), v(0.3, 1.85, -0.75)], ...legs, facing: -1 };
    case "think":
      // (the right elbow on the desk, the hand to the chin; the left hand on the desk)
      return { hip, neck: v(0, 3.5, -0.2), elbow: [v(-0.85, 2.7, -0.9), v(0.55, 2.75, -1.45)], hand: [v(-0.5, KEYS_H, -1.65), v(0.15, 3.55, -0.75)], ...legs, facing: -1 };
    case "wait":
      // (turned round on the stool towards the viewer, the right arm raised; feet the other way)
      return {
        hip, neck: v(0, 3.55, 0.25), elbow: [v(-0.8, 2.35, 0.45), v(1.05, 3.95, 0.35)], hand: [v(-0.6, 1.85, 0.95), v(1.15, 4.85, 0.45)],
        knee: [v(-0.45, 1.45, 1.25), v(0.45, 1.45, 1.25)], foot: [v(-0.45, 0.12, 1.45), v(0.45, 0.12, 1.45)], facing: 1,
      };
    case "idle":
      // (leaning back, arms crossed over the chest)
      return { hip, neck: v(0, 3.4, 0.6), elbow: [v(-0.85, 2.55, 0.0), v(0.85, 2.6, 0.0)], hand: [v(0.35, 2.85, -0.15), v(-0.35, 2.9, -0.1)], ...legs, facing: -1 };
    case "cafe":
      // (at the cafeteria's table: forearms on it, the right hand round a cup)
      return { hip, neck: v(0, 3.5, -0.15), elbow: [v(-0.85, 2.6, -0.8), v(0.85, 2.6, -0.8)], hand: [v(-0.35, KEYS_H, -1.55), v(0.4, KEYS_H, -1.6)], ...legs, facing: -1 };
    case "sip":
      // (sipping: the right hand lifts the cup to the mouth)
      return { hip, neck: v(0, 3.55, 0.0), elbow: [v(-0.85, 2.6, -0.8), v(0.75, 2.75, -0.55)], hand: [v(-0.35, KEYS_H, -1.55), v(0.15, 3.75, -0.75)], ...legs, facing: -1 };
    case "nap":
      // (bent over onto the desk, the head on folded arms)
      return { hip, neck: v(0, 2.95, -1.25), elbow: [v(-0.95, 2.72, -1.75), v(0.95, 2.72, -1.75)], hand: [v(0.2, 2.75, -2.15), v(-0.2, 2.8, -2.1)], ...legs, facing: -1 };
  }
}

/** turned by `yaw` about the seat (radians; 0 faces −z, the desk; π/2 faces −x): the figure faces (−sin yaw, −cos yaw) */
const turn = (p: V3, yaw: number): V3 => (yaw ? v(p.x * Math.cos(yaw) + p.z * Math.sin(yaw), p.h, -p.x * Math.sin(yaw) + p.z * Math.cos(yaw)) : p);
/** the way a figure turned by `yaw` looks, on the ground */
export const forward = (doing: Doing, yaw = 0): V3 => turn(v(0, 0, facing(doing)), yaw);

/** a pose's bones, turned by `yaw` about the seat (T210; the order doesn't matter: sorting decides the order drawn) */
export function figureBones(doing: Doing, yaw = 0): Bone[] {
  return poseBones(doing).map((b) => ({ ...b, a: turn(b.a, yaw), b: turn(b.b, yaw), side: turn(b.side ?? v(1, 0, 0), yaw) }));
}
function poseBones(doing: Doing): Bone[] {
  const j = joints(doing);
  const up = norm(sub(j.neck, j.hip));
  const shoulder = (k: number) => add(add(j.neck, mul(up, -0.3)), v(k * 0.85, 0, 0));
  const bones: Bone[] = [
    { name: "pelvis", a: add(j.hip, v(0, -0.25, 0)), b: add(j.hip, v(0, 0.2, 0)), w: 1.5, t: 0.95, stuff: "pants" },
    { name: "torso", a: j.hip, b: j.neck, w: 1.55, t: 0.8, stuff: "shirt" },
    { name: "neck", a: j.neck, b: add(j.neck, mul(up, 0.3)), w: 0.4, t: 0.4, stuff: "skin" },
    { name: "head", a: add(j.neck, mul(up, 0.25)), b: add(j.neck, mul(up, 1.35)), w: 1.15, t: 1.1, stuff: "hair" },
  ];
  ([-1, 1] as const).forEach((k, i) => {
    const s = k < 0 ? "l" : "r", sh = shoulder(k), hipJ = add(j.hip, v(k * 0.45, 0, 0));
    bones.push(
      { name: `upper-${s}`, a: sh, b: j.elbow[i], w: 0.42, t: 0.42, stuff: "shirt" },
      { name: `fore-${s}`, a: j.elbow[i], b: j.hand[i], w: 0.38, t: 0.38, stuff: "shirt" },
      { name: `hand-${s}`, a: j.hand[i], b: add(j.hand[i], mul(norm(sub(j.hand[i], j.elbow[i])), 0.35)), w: 0.36, t: 0.22, stuff: "skin" },
      { name: `thigh-${s}`, a: hipJ, b: j.knee[i], w: 0.55, t: 0.55, stuff: "pants" },
      { name: `shin-${s}`, a: j.knee[i], b: j.foot[i], w: 0.45, t: 0.45, stuff: "pants" },
      // (the feet point the way the face looks: the heel a little behind the ankle, the toes ahead)
      { name: `foot-${s}`, a: add(j.foot[i], v(0, 0, -0.15 * j.facing)), b: add(j.foot[i], v(0, 0, 0.6 * j.facing)), w: 0.45, t: 0.24, stuff: "shoe", side: v(1, 0, 0) },
    );
  });
  // (the coffee, upright in the right hand)
  if (doing === "cafe" || doing === "sip") {
    const h = j.hand[1];
    bones.push({ name: "cup", a: add(h, v(0.05, -0.05, -0.1)), b: add(h, v(0.05, 0.45, -0.1)), w: 0.36, t: 0.36, stuff: "cup", side: v(1, 0, 0) });
  }
  return bones;
}

/** which way the face looks (−z: at the screen, away from the viewer; +z: towards the viewer) */
export const facing = (doing: Doing) => joints(doing).facing;

/** a bone's visible faces, each with its outward normal and its depth, and its shade (1 = the top's) */
export type Face = { bone: Bone; pts: V3[]; normal: V3; shade: number; depth: number };
export function boneFaces(b: Bone): Face[] {
  const d = norm(sub(b.b, b.a));
  // (across: the bone's side axis, near x, square to the bone; then the thickness, square to both)
  const s0 = b.side ?? v(1, 0, 0);
  let w = sub(s0, mul(d, dot(s0, d)));
  if (Math.hypot(w.x, w.h, w.z) < 1e-6) w = v(0, 0, 1);
  w = norm(w);
  const t = norm(cross(d, w));
  const c = (e: V3, sw: number, st: number) => add(add(e, mul(w, (sw * b.w) / 2)), mul(t, (st * b.t) / 2));
  const A = [c(b.a, -1, -1), c(b.a, 1, -1), c(b.a, 1, 1), c(b.a, -1, 1)], B = [c(b.b, -1, -1), c(b.b, 1, -1), c(b.b, 1, 1), c(b.b, -1, 1)];
  const faces: { pts: V3[]; normal: V3 }[] = [
    { pts: [A[1], B[1], B[2], A[2]], normal: w },
    { pts: [A[0], A[3], B[3], B[0]], normal: mul(w, -1) },
    { pts: [A[2], B[2], B[3], A[3]], normal: t },
    { pts: [A[0], B[0], B[1], A[1]], normal: mul(t, -1) },
    { pts: B, normal: d },
    { pts: A, normal: mul(d, -1) },
  ];
  const mid = mul(add(b.a, b.b), 0.5);
  return faces
    .filter((f) => dot(f.normal, VIEW) > 1e-6)
    .map((f) => ({ bone: b, pts: f.pts, normal: f.normal, shade: 0.5 + 0.5 * Math.max(0, f.normal.h) + 0.19 * Math.max(0, f.normal.z), depth: depth(mid) }));
}

/** a pose's faces, back to front (a bone's faces never cross one another: they keep their order) */
export const figureFaces = (doing: Doing, yaw = 0): Face[] => figureBones(doing, yaw).flatMap(boneFaces).sort((a, b) => a.depth - b.depth);
