/**
 * What Escape does in Agents City (City and Table): it closes the nearest
 * thing that is open, one per press, and only when nothing is left does it
 * fly the camera back to the mode's default. Pure, so the order is tested.
 */
export type EscapeState = {
  /** typing in an input (Escape is the input's) */
  typing: boolean;
  /** an inner layer already used it (a menu, the Table's board close-up: they preventDefault) */
  handled: boolean;
  /** a message is open in its sheet (the sheet closes itself) */
  messageOpen: boolean;
  /** the full-viewport overlay (where native full screen is missing; native full screen eats Escape itself) */
  overlay: boolean;
  /** an agent, file, commit or task selected (its card shown) */
  selected: boolean;
  /** the camera follows an agent */
  following: boolean;
};

export type EscapeAction = "none" | "exit-overlay" | "deselect" | "reset-camera";

export function escapeAction(s: EscapeState): EscapeAction {
  if (s.typing || s.handled || s.messageOpen) return "none";
  if (s.overlay) return "exit-overlay";
  // (a click on an agent selects and follows it: one Escape lets go of both)
  if (s.selected || s.following) return "deselect";
  return "reset-camera";
}
