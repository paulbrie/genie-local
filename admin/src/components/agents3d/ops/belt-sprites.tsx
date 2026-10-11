"use client";

import { useEffect, useMemo, useState } from "react";

import type { CityBounds } from "@/lib/city-layout";

import { beltPlaces, PKG } from "./belt";
import type { DeskLine } from "./desks";
import { iso, type P2 } from "./iso";
import type { OpsAgent, OpsCommit } from "./model";

type Fit = { k: number; ox: number; oy: number };
const px = (f: Fit, p: P2): P2 => ({ x: f.ox + p.x * f.k, y: f.oy + p.y * f.k });
const pts = (ps: P2[]) => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
const INK = "#0b0f17";

/**
 * The commits' conveyor belt (T201), drawn on the map (it zooms and pans with it): the belt along the cities' front,
 * and on it the newest commits as packages in their authors' colours, labelled with the task id or short hash (the
 * subject, repo and hash on hover), a tick on those pushed. A new commit drops onto the belt at its author's desk
 * and rides to its place in a CSS transition (0.9 s, once; none under reduced motion); the packages it pushes back
 * slide the same way. Nothing moves otherwise, nothing runs per frame.
 */
export function Belt({ line, fit, cities, commits, agents }: { line: DeskLine; fit: Fit; cities: CityBounds[]; commits: OpsCommit[]; agents: OpsAgent[] }) {
  const { belt, wu } = line;
  const places = useMemo(() => beltPlaces(commits, cities, line), [commits, cities, line]);
  const seatOf = useMemo(() => new Map(agents.map((a, i) => [a.key, line.seats[i]?.x ?? belt.x0])), [agents, line, belt.x0]);
  const colorOf = useMemo(() => new Map(agents.map((a) => [a.key, a.color])), [agents]);
  const nameOf = useMemo(() => new Map(agents.map((a) => [a.key, a.name])), [agents]);

  // (packages seen before ride to their place; a new one shows first over its author's desk, then rides; the first
  // drawing has nothing new: no ride)
  const [landed, setLanded] = useState<Set<string>>(() => new Set(commits.map((c) => c.hash)));
  const fresh = commits.filter((c) => !landed.has(c.hash));
  useEffect(() => {
    const now = commits.filter((c) => !landed.has(c.hash));
    if (!now.length) return;
    // (two frames: the drop place painted first, so the move to the belt's place transitions)
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setLanded(new Set(commits.map((c) => c.hash)))); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [commits, landed]);

  const zc = (belt.z0 + belt.z1) / 2, s = PKG * wu, h = belt.h;
  // the belt: a long low box, its top ribbed across
  const quad = (x0: number, x1: number, z0: number, z1: number, y: number) => [iso(x0, z0, y), iso(x1, z0, y), iso(x1, z1, y), iso(x0, z1, y)].map((p) => px(fit, p));
  const top = quad(belt.x0, belt.x1, belt.z0, belt.z1, h);
  const front = [iso(belt.x0, belt.z1, h), iso(belt.x1, belt.z1, h), iso(belt.x1, belt.z1, 0), iso(belt.x0, belt.z1, 0)].map((p) => px(fit, p));
  const end = [iso(belt.x1, belt.z0, h), iso(belt.x1, belt.z1, h), iso(belt.x1, belt.z1, 0), iso(belt.x1, belt.z0, 0)].map((p) => px(fit, p));
  const ribs: [P2, P2][] = [];
  for (let x = belt.x0 + wu; x < belt.x1; x += 1.5 * wu) ribs.push([px(fit, iso(x, belt.z0, h)), px(fit, iso(x, belt.z1, h))]);
  // a package, in the map's own units (its group scaled by the fit, so a zoom doesn't set off the ride)
  const box = (x0: number, x1: number, z0: number, z1: number, h0: number, h1: number) => ({
    top: [iso(x0, z0, h1), iso(x1, z0, h1), iso(x1, z1, h1), iso(x0, z1, h1)],
    front: [iso(x0, z1, h1), iso(x1, z1, h1), iso(x1, z1, h0), iso(x0, z1, h0)],
    side: [iso(x1, z0, h1), iso(x1, z1, h1), iso(x1, z1, h0), iso(x1, z0, h0)],
  });
  const pkg = box(-s / 2, s / 2, -s / 2, s / 2, 0, s);
  const label = s * fit.k >= 14;
  return (
    <g className="pointer-events-none">
      <polygon points={pts(front)} fill="#1c2230" stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(end)} fill="#161b26" stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(top)} fill="#2b3343" stroke={INK} strokeWidth={0.6} />
      {ribs.map(([a, b], i) => <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#3b4557" strokeWidth={1} />)}
      <g transform={`matrix(${fit.k} 0 0 ${fit.k} ${fit.ox} ${fit.oy})`}>
        {commits.map((c) => {
          const drop = fresh.includes(c);
          const at = drop ? iso(seatOf.get(c.by) ?? belt.x0, zc, h + 2.5 * wu) : iso(places.get(c.hash) ?? belt.x1, zc, h);
          const color = colorOf.get(c.by) ?? "#94a3b8";
          return (
            <g key={c.hash} className="ops-pkg pointer-events-auto" style={{ transform: `translate(${at.x.toFixed(3)}px, ${at.y.toFixed(3)}px)` }}>
              <title>{`${c.label} · ${c.subject}\n${c.repo ? c.repo.split("/").pop() : "another repo"} · ${c.hash.slice(0, 7)} · ${nameOf.get(c.by) ?? c.by}${c.pushed ? " · pushed" : ""}`}</title>
              <polygon points={pts(pkg.front)} fill={color} fillOpacity={0.75} stroke={INK} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
              <polygon points={pts(pkg.side)} fill={color} fillOpacity={0.55} stroke={INK} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
              <polygon points={pts(pkg.top)} fill={color} stroke={INK} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
              {/* (the parcel's tape across its top) */}
              <line x1={iso(0, -s / 2, s).x} y1={iso(0, -s / 2, s).y} x2={iso(0, s / 2, s).x} y2={iso(0, s / 2, s).y} stroke="#fff" strokeOpacity={0.55} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              {c.pushed && (
                <path d={`M${iso(-s * 0.25, 0, s).x},${iso(-s * 0.25, 0, s).y} l${s * 0.12},${s * 0.12} l${s * 0.28},${-s * 0.3}`} fill="none" stroke="#f8fafc" strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {label && (
                <text y={iso(0, 0, s).y - 6 / fit.k} textAnchor="middle" fill="#e2e8f0" fontSize={9 / fit.k} fontFamily="ui-monospace, monospace" style={{ paintOrder: "stroke", stroke: INK, strokeWidth: 2.5 / fit.k }}>
                  {c.label}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </g>
  );
}
