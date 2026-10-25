// Types for core.mjs (kept as plain JS so the raw-Node board hub can import it).

export type Author = { id: string; name: string; color: string };

type Base = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  author?: Author;
  createdAt: number;
  /** A facilitator suggestion not yet accepted. */
  suggestion?: true;
  /** Dot votes by participant id. */
  votes?: Record<string, number>;
};

export type Side = "top" | "right" | "bottom" | "left";
export type ConnectorEnd = { id?: string; x: number; y: number; side?: Side };
export type Message = { id: string; author: Author; text: string; at: number };
export type ChatMessage = Message & { role: "user" | "claude"; pending?: true };

export type Sticky = Base & { type: "sticky"; text: string; color: string };
export type TextBox = Base & { type: "text"; text: string; color: string; fontSize: number };
export type ShapeKind = "rect" | "roundrect" | "ellipse" | "diamond" | "triangle";
export type Shape = Base & { type: "shape"; shape: ShapeKind; text: string; color: string; stroke: string };
export type Section = Base & { type: "section"; title: string; color: string; fontSize: number; collapsed?: true };
export type Connector = Base & {
  type: "connector";
  from: ConnectorEnd;
  to: ConnectorEnd;
  label: string;
  arrow: "end" | "both" | "none";
  color: string;
  dashed?: true;
  curved?: true;
};
export type Pen = Base & { type: "pen"; points: [number, number][]; color: string; width: number };
export type ImageObj = Base & { type: "image"; src: string; alt: string };
export type CommentObj = Base & { type: "comment"; thread: Message[]; resolved: boolean };

export type BoardObject = Sticky | TextBox | Shape | Section | Connector | Pen | ImageObj | CommentObj;
export type ObjectType = BoardObject["type"];

export type Timer = { durationMs: number; endsAt: number | null; remainingMs: number | null };
export type Meta = {
  timer: Timer | null;
  voting: { maxVotes: number } | null;
  facilitator: boolean;
};

export type BoardDoc = {
  v: number;
  objects: Record<string, BoardObject>;
  meta: Meta;
  chat: ChatMessage[];
};

/** Partial fields of any object type (what a patch may set). */
export type ObjectFields = Partial<
  Omit<Sticky, "type"> &
    Omit<TextBox, "type"> &
    Omit<Shape, "type"> &
    Omit<Section, "type"> &
    Omit<Connector, "type"> &
    Omit<Pen, "type"> &
    Omit<ImageObj, "type"> &
    Omit<CommentObj, "type">
>;

export type Op =
  | { k: "put"; obj: BoardObject | (Partial<BoardObject> & { id: string; type: ObjectType }) }
  | { k: "patch"; id: string; set: ObjectFields }
  | { k: "del"; id: string }
  | { k: "vote"; id: string; delta: 1 | -1 }
  | { k: "clearVotes" }
  | { k: "reply"; id: string; msg: { id: string; text: string } }
  | { k: "meta"; set: Partial<Meta> }
  | { k: "chat"; msg: { id: string; text: string; role?: "user" | "claude"; pending?: boolean; author?: Author } };

/** The op language Claude and agents write (see translateAgentOps). */
export type AgentOp = {
  op: "create" | "connect" | "update" | "move" | "delete" | "reply";
  ref?: string;
  id?: string;
  type?: ObjectType;
  from?: string;
  to?: string;
  [field: string]: unknown;
};

export const DOC_VERSION: number;
export const LIMITS: {
  objects: number;
  text: number;
  title: number;
  penPoints: number;
  thread: number;
  chat: number;
  coord: number;
  size: number;
  votesPerUser: number;
};
export const COLORS: Record<string, string>;
export const INKS: Record<string, string>;
export const PARTICIPANT_COLORS: string[];
export const CLAUDE_ID: string;
export const CLAUDE_COLOR: string;
export const OBJECT_TYPES: ObjectType[];
export const SHAPES: ShapeKind[];
export const ARROWS: Connector["arrow"][];
export const SIDES: ("auto" | Side)[];
export const ASSET_PREFIX: string;
export const DEFAULT_SIZES: Record<string, { w: number; h: number }>;

export function emptyDoc(): BoardDoc;
export function normalizeDoc(raw: unknown): BoardDoc;
export function sanitizeObject(o: unknown): BoardObject | null;
export function sanitizeMeta(m: unknown): Meta;
export function isId(v: unknown): v is string;
export function attachedConnectors(doc: Pick<BoardDoc, "objects">, ids: string[]): string[];
export function maxZ(doc: BoardDoc): number;
export function minZ(doc: BoardDoc): number;
export function applyOps(doc: BoardDoc, ops: Op[], actor: Author | null, now: number): BoardDoc;
export function newId(prefix?: string): string;
export function contentBounds(
  doc: BoardDoc,
  filter?: (o: BoardObject) => boolean,
): { x: number; y: number; w: number; h: number } | null;
export function findFreeSpot(
  doc: BoardDoc,
  w: number,
  h: number,
  near?: { x: number; y: number },
): { x: number; y: number };
export function translateAgentOps(
  doc: BoardDoc,
  agentOps: AgentOp[],
  actor: Author,
  now: number,
): { ops: Op[]; created: Record<string, string>; errors: string[]; doc: BoardDoc };
export function opFocus(doc: BoardDoc, op: Op): { x: number; y: number } | null;
export function describeBoard(
  doc: BoardDoc,
  opts?: { only?: Set<string>; maxText?: number; names?: boolean },
): string;
export function hiddenByCollapsed(doc: BoardDoc): Set<string>;
export function sectionChildIds(doc: BoardDoc, sectionId: string): string[];
export function fitSectionOps(doc: BoardDoc, sectionId: string, pad?: number): Op[];
export function arrangeSectionOps(doc: BoardDoc, sectionId: string, opts?: { gap?: number; pad?: number }): Op[];
