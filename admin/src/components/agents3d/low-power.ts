"use client";

import { useEffect, useState } from "react";
import { setLowPowerFrames } from "./frame-governor";

/**
 * Agents City's Low power switch (T162, T143's research): the 3D views drawn cheaper — no bloom, dpr 1, no
 * antialiasing or MSAA, every frame at most 30 a second and ambient motion (busy drones bobbing, busy avatars typing)
 * at most 15. Remembered in this browser once switched; until then on by itself under prefers-reduced-motion, or
 * when the browser says it runs on battery (Chrome's Battery Status API; elsewhere it can't tell).
 */
const KEY = "admin.agents3d.lowPower";

type Battery = EventTarget & { charging: boolean };
const hasBattery = (n: Navigator): n is Navigator & { getBattery: () => Promise<Battery> } => "getBattery" in n && typeof n.getBattery === "function";

/** [on, set]: the switch, as chosen or (never chosen) as the reduced-motion setting and the battery suggest */
export function useLowPower(reduced: boolean): [boolean, (on: boolean) => void] {
  const [pref, setPref] = useState<boolean | null>(null);
  const [onBattery, setOnBattery] = useState(false);
  useEffect(() => {
    const v = localStorage.getItem(KEY);
    if (v === "1" || v === "0") setPref(v === "1"); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);
  useEffect(() => {
    if (!hasBattery(navigator)) return;
    let b: Battery | null = null, gone = false;
    const sync = () => b && setOnBattery(!b.charging);
    void navigator.getBattery().then((x) => {
      if (gone) return;
      b = x;
      sync();
      b.addEventListener("chargingchange", sync);
    }, () => {});
    return () => {
      gone = true;
      b?.removeEventListener("chargingchange", sync);
    };
  }, []);
  const on = pref ?? (reduced || onBattery);
  useEffect(() => {
    setLowPowerFrames(on);
    return () => setLowPowerFrames(false);
  }, [on]);
  const set = (v: boolean) => {
    setPref(v);
    localStorage.setItem(KEY, v ? "1" : "0");
  };
  return [on, set];
}
