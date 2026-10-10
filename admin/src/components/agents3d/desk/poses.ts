/**
 * Procedural poses: each frame sets a handful of joint rotations from
 * (action, time, progress). The lower body walks whenever the avatar is moving;
 * the upper body acts out the action. Reduced motion passes t = 0 and holds a still pose.
 */
import type { Avatar } from "./avatar";

export type Pose =
  | "idle"
  | "type"
  | "read"
  | "run"
  | "carry"
  | "give"
  | "plant"
  | "unplant"
  | "stack"
  | "wave"
  | "cheer"
  | "blocked"
  | "nap"
  | "wait"
  /** Waiting on its user, waving to them: seated upright, the right hand up and waving. */
  | "hail"
  // Seated states: the idle variants…
  | "sip"
  | "pencil"
  | "stretch"
  // …and the thinking postures (see THINK_POSES).
  | "think"
  | "thinker"
  | "headrest"
  | "pencilChin"
  | "chinHands"
  | "crossed"
  | "steeple"
  | "handMouth"
  | "swivel"
  // DONE: the happy dances (see DANCES).
  | "jumpUp"
  | "chairSpin"
  | "fistPump"
  | "shimmy"
  | "robot"
  | "twirl"
  | "raiseRoof"
  | "bothWave";

/** Thinking postures; one is picked per agent and per thinking spell. */
export const THINK_POSES: Pose[] = ["think", "thinker", "headrest", "pencilChin", "chinHands", "crossed", "steeple", "handMouth", "swivel"];

/** Happy dances for a DONE, each over one cheer beat (~3 s); `k` runs 0..1 through it. */
export const DANCES: Pose[] = ["jumpUp", "chairSpin", "fistPump", "shimmy", "robot", "twirl", "raiseRoof", "bothWave"];
export const isDance = (p: Pose) => DANCES.includes(p);

/** Idle agents cycle through these, each for IDLE_SLOT_S, out of step with each other; long idle adds naps. */
const IDLE_POSES: Pose[] = ["sip", "pencil", "stretch", "idle"];
const LONG_IDLE_POSES: Pose[] = ["nap", "sip", "nap", "pencil", "stretch"];
const IDLE_SLOT_S = 14;

/**
 * The idle variant an agent is in at real time `ms` (shared by the avatar and its label).
 * Asleep (see asleepAt) it holds the nap: nothing cycles in until it acts again.
 */
export function idlePose(seed: number, ms: number, long: boolean, asleep = false): Pose {
  if (asleep) return "nap";
  const list = long ? LONG_IDLE_POSES : IDLE_POSES;
  const slot = Math.floor(ms / 1000 / IDLE_SLOT_S + (seed % 97) / 97);
  return list[(slot + seed) % list.length];
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Standing up (on the chair): legs straight. */
function stand(j: Avatar["joints"]) {
  j.legL.rotation.set(0, 0, 0);
  j.legR.rotation.set(0, 0, 0);
}

/**
 * Apply a pose. `t` real seconds, `k` progress 0..1 through a one-shot. Returns a vertical hop.
 * `seated`: on a chair at the table (thighs forward; napping is head-down on the arms).
 */
export function applyPose(a: Avatar, pose: Pose, t: number, k: number, moving: boolean, still: boolean, seated = false): number {
  const j = a.joints;
  const p = a.props;
  const s = (f: number, ph = 0) => (still ? 0 : Math.sin(t * f + ph));

  // Neutral.
  a.root.rotation.y = 0;
  j.body.position.set(0, s(2) * 0.01, 0);
  j.body.rotation.set(0, 0, 0);
  j.head.rotation.set(s(0.9) * 0.04, s(0.6) * 0.12, s(0.7) * 0.03);
  j.armL.rotation.set(0, 0, -0.18);
  j.armR.rotation.set(0, 0, 0.18);
  j.legL.position.y = j.legR.position.y = 0.5;
  j.legL.rotation.set(0, 0, 0);
  j.legR.rotation.set(0, 0, 0);
  const blink = !still && t % 3.7 < 0.12;
  for (const e of j.eyes) e.scale.y = blink ? 0.01 : 0.075;
  if (p.accessory) p.accessory.visible = false;
  p.envelope.visible = p.scroll.visible = p.flag.visible = p.block.visible = p.mug.visible = p.pencil.visible = false;
  let hop = 0;
  if (seated) {
    j.legL.rotation.set(-1.5, 0, -0.06);
    j.legR.rotation.set(-1.5, 0, 0.06);
  }

  if (moving) {
    const w = s(9);
    j.legL.rotation.x = w * 0.55;
    j.legR.rotation.x = -w * 0.55;
    j.armL.rotation.x = -w * 0.45;
    j.armR.rotation.x = w * 0.45;
    hop = still ? 0 : Math.abs(Math.cos(t * 9)) * 0.06;
  }

  switch (pose) {
    case "idle":
      if (p.accessory && !moving) {
        p.accessory.visible = true;
        j.armL.rotation.set(-0.9, 0, -0.35);
      }
      break;
    case "type":
      // Upright and close to the laptop, both hands on the keys, nodding at the screen.
      j.body.rotation.x = 0.16;
      j.head.rotation.set(0.22 + Math.max(0, s(2.2)) * 0.07, s(0.5) * 0.05, 0);
      j.armL.rotation.set(-1.2 + Math.max(0, s(15)) * 0.2, 0, 0.16);
      j.armR.rotation.set(-1.2 + Math.max(0, s(15, 2)) * 0.2, 0, -0.16);
      j.body.position.y += Math.max(0, s(15)) * 0.008;
      break;
    case "read":
      p.scroll.visible = true;
      j.head.rotation.set(0.35, s(0.5) * 0.15, 0);
      j.armR.rotation.set(-1.25, 0.3, 0.1);
      j.armL.rotation.set(-1.15, -0.3, -0.25);
      break;
    case "run": {
      // Pressing the big button.
      const press = Math.max(0, s(5));
      j.body.rotation.x = 0.12;
      j.head.rotation.x = 0.25;
      j.armR.rotation.set(-1.0 - (1 - press) * 0.5, 0, 0.1);
      break;
    }
    case "carry":
      p.envelope.visible = true;
      j.armR.rotation.set(-1.7 + s(4) * 0.1, 0, 0.1);
      break;
    case "give":
      p.envelope.visible = k < 0.75;
      j.armR.rotation.set(-1.4, 0, 0);
      j.body.rotation.x = 0.1;
      break;
    case "plant":
      if (k < 0.55) {
        p.flag.visible = true;
        j.armR.rotation.set(-2.7, 0, 0.1);
        hop = still ? 0 : Math.max(0, s(6)) * 0.08;
      } else {
        j.armR.rotation.set(-0.9, 0, 0.1);
        j.body.rotation.x = 0.2;
      }
      break;
    case "unplant":
      p.flag.visible = k > 0.3;
      j.armR.rotation.set(k > 0.3 ? -0.4 : -1.2, 0, 0.1);
      break;
    case "stack":
      if (k < 0.6) {
        p.block.visible = true;
        j.armR.rotation.set(-2.9, 0, 0.35);
        j.armL.rotation.set(-2.9, 0, -0.35);
      } else {
        j.armR.rotation.set(-1.6, 0, 0.2);
        j.armL.rotation.set(-1.6, 0, -0.2);
        j.body.rotation.x = 0.15;
      }
      break;
    case "wave":
      if (p.accessory) {
        p.accessory.visible = true;
        j.armL.rotation.set(-0.9, 0, -0.35);
      }
      j.armR.rotation.set(0, 0, 2.6 + s(8) * 0.35);
      j.head.rotation.x = -0.15;
      break;
    case "cheer":
      j.armR.rotation.set(0, 0, 2.7 + s(10) * 0.15);
      j.armL.rotation.set(0, 0, -2.7 - s(10, 1) * 0.15);
      hop = still ? 0 : Math.abs(Math.sin(t * 7)) * 0.45;
      break;
    case "blocked":
      j.armR.rotation.set(-2.5, 0, -0.6 + s(10) * 0.08); // scratching the head
      j.head.rotation.set(0, 0, 0.25);
      break;
    case "think":
      // Leaning back, looking at the ceiling, hands folded on the belly.
      j.body.rotation.x = -0.22;
      j.head.rotation.set(-0.5, s(0.4) * 0.25, 0.1);
      j.armL.rotation.set(-0.75, 0, 0.5);
      j.armR.rotation.set(-0.75, 0, -0.5);
      break;
    case "thinker":
      // Chin on the right fist, leaning in; the other hand on the lap.
      j.body.rotation.x = 0.18;
      j.head.rotation.set(0.12, s(0.3) * 0.08, -0.08);
      j.armR.rotation.set(-2.35, 0, -0.62);
      j.armL.rotation.set(-0.55, 0, 0.35);
      break;
    case "headrest":
      // Hands behind the head, reclined (arms up and back, hands by the ears).
      j.body.rotation.x = -0.3;
      j.head.rotation.set(-0.2, s(0.35) * 0.15, 0);
      j.armL.rotation.set(-1.05, 0, -2.3);
      j.armR.rotation.set(-1.05, 0, 2.3);
      break;
    case "pencilChin":
      // Tapping a pencil on the chin, eyes up.
      p.pencil.visible = true;
      p.pencil.rotation.z = 1.1;
      j.head.rotation.set(-0.2, s(0.4) * 0.1, 0.05);
      j.armR.rotation.set(-2.15 - Math.max(0, s(5)) * 0.12, 0, -0.5);
      j.armL.rotation.set(-0.6, 0, 0.3);
      break;
    case "chinHands":
      // Chin in both hands, elbows on the table, gazing ahead.
      j.body.rotation.x = 0.26;
      j.head.rotation.set(-0.08, s(0.3) * 0.1, s(0.4) * 0.05);
      j.armL.rotation.set(-2.2, 0, 0.5);
      j.armR.rotation.set(-2.2, 0, -0.5);
      break;
    case "crossed":
      // Arms crossed, head tilted.
      j.body.rotation.x = -0.08;
      j.head.rotation.set(-0.05, 0.1, 0.28 + s(0.5) * 0.04);
      j.armL.rotation.set(-1.3, 0, 0.78);
      j.armR.rotation.set(-1.22, 0, -0.78);
      break;
    case "steeple":
      // Elbows on the table, fingertips together in front of the face.
      j.body.rotation.x = 0.22;
      j.head.rotation.set(0.02, s(0.3) * 0.06, 0);
      j.armL.rotation.set(-1.95, 0, 0.58);
      j.armR.rotation.set(-1.95, 0, -0.58);
      break;
    case "handMouth":
      // Staring at the laptop, a hand over the mouth.
      j.body.rotation.x = 0.16;
      j.head.rotation.set(0.32, 0, 0);
      j.armR.rotation.set(-2.05, 0, -0.52);
      j.armL.rotation.set(-1.0, 0, 0.45);
      break;
    case "swivel":
      // Swivelling slowly side to side, looking up.
      j.body.rotation.y = s(0.7) * 0.4;
      j.head.rotation.set(-0.2, -s(0.7) * 0.15, 0);
      j.armL.rotation.set(-0.35, 0, -0.32);
      j.armR.rotation.set(-0.35, 0, 0.32);
      break;
    case "sip": {
      // Mug at the chest; every 5 s a sip (the cup rises to the mouth and tips).
      p.mug.visible = true;
      const ph = still ? 1 : (t % 5) / 5;
      const lift = ph < 0.35 ? Math.sin((ph / 0.35) * Math.PI) : 0;
      j.armR.rotation.set(-1.2 - 1.0 * lift, 0, -0.25 - 0.25 * lift);
      j.head.rotation.x = -0.25 * lift;
      j.armL.rotation.set(-0.3, 0, -0.1);
      break;
    }
    case "pencil":
      // Twirling a pencil, now and then tapping it.
      p.pencil.visible = true;
      p.pencil.rotation.z = still ? 0.6 : t * 7;
      j.armR.rotation.set(-1.25 + Math.max(0, s(3)) * 0.08, 0, 0.05);
      j.armL.rotation.set(-0.9, 0, 0.2);
      j.head.rotation.x = 0.18;
      break;
    case "stretch": {
      // Arms up and a lean back for ~3 s of every 8, then back to rest.
      const ph = still ? 0 : (t % 8) / 3;
      const up = ph < 1 ? Math.sin(ph * Math.PI) : 0;
      j.armL.rotation.set(0, 0, -0.18 - 2.75 * up);
      j.armR.rotation.set(0, 0, 0.18 + 2.75 * up);
      j.body.rotation.x = -0.15 * up;
      j.head.rotation.x = -0.3 * up;
      if (up > 0.6) for (const e of j.eyes) e.scale.y = 0.02; // eyes squeezed shut mid-stretch
      break;
    }
    // ── Dances (DONE): stand-ups lift onto the chair; returns the lift. ──
    case "jumpUp": {
      // Up on the chair, arms in a V, jumping.
      stand(j);
      j.armL.rotation.set(0, 0, -2.6);
      j.armR.rotation.set(0, 0, 2.6);
      hop = 0.4 + (still ? 0 : Math.abs(Math.sin(t * 7)) * 0.3);
      break;
    }
    case "chairSpin":
      // A full spin of the chair, arms out.
      a.root.rotation.y = still ? 0 : Math.PI * 2 * smooth(k);
      j.armL.rotation.set(0, 0, -1.45);
      j.armR.rotation.set(0, 0, 1.45);
      j.head.rotation.x = -0.2;
      break;
    case "fistPump":
      // The right fist pumping, the left on the hip.
      j.armR.rotation.set(-2.55 - Math.max(0, s(9)) * 0.45, 0, 0.1);
      j.armL.rotation.set(-0.3, 0, 0.9);
      j.head.rotation.x = -0.1 + Math.max(0, s(9)) * 0.12;
      break;
    case "shimmy":
      // A seated shimmy: shoulders wiggle, elbows swing.
      j.body.rotation.z = s(14) * 0.12;
      j.head.rotation.z = -s(14) * 0.1;
      j.armL.rotation.set(-1.15 + s(14) * 0.3, 0, -0.3);
      j.armR.rotation.set(-1.15 - s(14) * 0.3, 0, 0.3);
      break;
    case "robot": {
      // The robot: arms and head jump between stiff angles every 0.3 s.
      const step = still ? 0 : Math.floor(t / 0.3) % 4;
      j.armL.rotation.set(step % 2 ? -1.57 : 0, 0, step < 2 ? -1.57 : -0.1);
      j.armR.rotation.set(step % 2 ? 0 : -1.57, 0, step < 2 ? 0.1 : 1.57);
      j.head.rotation.set(0, [0.4, 0, -0.4, 0][step], 0);
      break;
    }
    case "twirl":
      // Up on the chair, a double twirl, arms out.
      stand(j);
      a.root.rotation.y = still ? 0 : Math.PI * 4 * smooth(k);
      j.armL.rotation.set(0, 0, -1.5);
      j.armR.rotation.set(0, 0, 1.5);
      hop = 0.4 + (still ? 0 : Math.abs(Math.sin(t * 5)) * 0.08);
      break;
    case "raiseRoof":
      // Raise the roof: both palms pushing up, again and again.
      j.armL.rotation.set(-2.85 + Math.max(0, s(8)) * 0.3, 0, -0.3);
      j.armR.rotation.set(-2.85 + Math.max(0, s(8)) * 0.3, 0, 0.3);
      j.head.rotation.x = -0.2 + Math.max(0, s(8)) * 0.1;
      j.body.position.y += Math.max(0, s(8)) * 0.03;
      break;
    case "bothWave":
      // Both arms up, waving side to side.
      j.armL.rotation.set(0, 0, -2.6 + s(6) * 0.4);
      j.armR.rotation.set(0, 0, 2.6 + s(6) * 0.4);
      j.body.rotation.z = s(6) * 0.08;
      break;
    case "wait":
      // Sitting up, hands resting on the table's edge (the head turns to whoever it waits on, in agents.tsx).
      j.body.rotation.x = -0.06;
      j.armL.rotation.set(-1.05, 0, 0.22);
      j.armR.rotation.set(-1.05, 0, -0.22);
      break;
    case "hail":
      // As in wait, the right hand raised and waving side to side.
      j.body.rotation.x = -0.06;
      j.armL.rotation.set(-1.05, 0, 0.22);
      j.armR.rotation.set(0, 0, 2.6 + s(9) * 0.35);
      break;
    case "nap":
      for (const e of j.eyes) e.scale.y = 0.008;
      if (seated) {
        // Head down on folded arms on the table, breathing slowly.
        j.body.rotation.x = 0.42 + s(1.2) * 0.015;
        j.head.rotation.set(0.45, 0, 0.3);
        j.armL.rotation.set(-1.45, 0, 0.55);
        j.armR.rotation.set(-1.45, 0, -0.55);
        break;
      }
      j.body.position.y = -0.38 + s(1.2) * 0.012;
      j.legL.position.y = j.legR.position.y = 0.14;
      j.legL.rotation.set(-1.45, 0, -0.1);
      j.legR.rotation.set(-1.45, 0, 0.1);
      j.head.rotation.set(0.25, 0, 0.35);
      j.armL.rotation.set(-0.3, 0, -0.35);
      j.armR.rotation.set(-0.3, 0, 0.35);
      break;
  }
  return hop;
}
