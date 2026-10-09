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
  | "nap";

/**
 * Apply a pose. `t` real seconds, `k` progress 0..1 through a one-shot. Returns a vertical hop.
 * `seated`: on a chair at the table (thighs forward; napping is head-down on the arms).
 */
export function applyPose(a: Avatar, pose: Pose, t: number, k: number, moving: boolean, still: boolean, seated = false): number {
  const j = a.joints;
  const p = a.props;
  const s = (f: number, ph = 0) => (still ? 0 : Math.sin(t * f + ph));

  // Neutral.
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
  p.envelope.visible = p.scroll.visible = p.flag.visible = p.block.visible = false;
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
      j.head.rotation.x = 0.3;
      j.body.rotation.x = 0.08;
      j.armL.rotation.set(-1.15 + Math.max(0, s(15)) * 0.18, 0, -0.12);
      j.armR.rotation.set(-1.15 + Math.max(0, s(15, 2)) * 0.18, 0, 0.12);
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
