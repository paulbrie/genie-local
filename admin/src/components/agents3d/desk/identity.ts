/**
 * Who looks like what on the desk: trim, skin, hair and accessory per name; the
 * hoodie is the agent's colour (agentColorMap, shared with Comms and the City).
 * Unknown sessions get a generic look picked from their key.
 */
export type HairStyle = "quiff" | "spiky" | "bun" | "bob" | "buzz";
export type Accessory = "clipboard" | "glasses" | "headset" | "bow" | "magnifier" | "cap" | "beanie" | "none";

export type Look = {
  hoodie: string;
  trim: string;
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  accessory: Accessory;
};

const LOOKS: Record<string, Omit<Look, "hoodie">> = {
  alice: { trim: "#c97cf0", skin: "#eaa77f", hair: "#1c1918", hairStyle: "quiff", accessory: "clipboard" },
  bob: { trim: "#facc15", skin: "#c68863", hair: "#3b2a20", hairStyle: "buzz", accessory: "glasses" },
  alex: { trim: "#f8fafc", skin: "#f1c7a5", hair: "#9a4a22", hairStyle: "spiky", accessory: "headset" },
  tatiana: { trim: "#fb7185", skin: "#e0ac8a", hair: "#2b1b14", hairStyle: "bob", accessory: "bow" },
  ramona: { trim: "#7dd3fc", skin: "#8d5a3b", hair: "#1a1110", hairStyle: "bun", accessory: "magnifier" },
  tom: { trim: "#fb923c", skin: "#f0b892", hair: "#6b4a2e", hairStyle: "buzz", accessory: "cap" },
};

const SKINS = ["#f1c7a5", "#eaa77f", "#c68863", "#8d5a3b", "#e0ac8a"];
const HAIRS = ["#1c1918", "#3b2a20", "#6b4a2e", "#9a4a22", "#d6b26a"];
const STYLES: HairStyle[] = ["quiff", "bob", "bun", "spiky", "buzz"];
const TRIMS = ["#f8fafc", "#fde68a", "#c4b5fd", "#fecdd3", "#bae6fd"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** First word of the name, lower-cased: "Alice (manager)" → "alice". */
const nameKey = (name: string) => name.trim().split(/[\s(]/)[0].toLowerCase();

export function lookFor(key: string, name: string, hoodie: string): Look {
  const known = LOOKS[nameKey(name)];
  if (known) return { hoodie, ...known };
  const h = hash(key);
  return {
    hoodie,
    trim: TRIMS[h % TRIMS.length],
    skin: SKINS[(h >>> 3) % SKINS.length],
    hair: HAIRS[(h >>> 6) % HAIRS.length],
    hairStyle: STYLES[(h >>> 9) % STYLES.length],
    accessory: "beanie",
  };
}
