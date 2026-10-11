"use client";

import { useEffect, useMemo, useState } from "react";

import { beltPlaces, PKG } from "./belt";
import type { Belt as BeltStrip, DeskLine } from "./desks";
import { iso, type P2 } from "./iso";
import type { OpsAgent, OpsCommit } from "./model";

type Fit = { k: number; ox: number; oy: number };
const px = (f: Fit, p: P2): P2 => ({ x: f.ox + p.x * f.k, y: f.oy + p.y * f.k });
const pts = (ps: P2[]) => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
const INK = "#0b0f17";

/**
 * The commits' conveyor belts (T201, T204), drawn on the map (they zoom and pan with it) under the cities: one along
 * each city's far side, and on it that repo's newest commits as packages in their authors' colours, labelled with the
 * task id or short hash (the subject, repo and hash on hover), a tick on those pushed. A new commit appears over its
 * place and drops onto its belt in a CSS transition (0.9 s, once; none under reduced motion); the packages it pushes
 * back slide along the same way. Nothing moves otherwise, nothing runs per frame.
 */
export function Belts({ line, fit, commits, agents }: { line: DeskLine; fit: Fit; commits: OpsCommit[]; agents: OpsAgent[] }) {
  const { wu } = line;
  const places = useMemo(() => beltPlaces(commits, line), [commits, line]);
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

  const s = PKG * wu;
  // a belt: a long low box, its top ribbed across
  const strip = (b: BeltStrip) => {
    const P = (x: number, z: number, y: number) => px(fit, iso(x, z, y));
    const ribs: [P2, P2][] = [];
    for (let x = b.x0 + wu; x < b.x1; x += 1.5 * wu) ribs.push([P(x, b.z0, b.h), P(x, b.z1, b.h)]);
    return {
      top: [P(b.x0, b.z0, b.h), P(b.x1, b.z0, b.h), P(b.x1, b.z1, b.h), P(b.x0, b.z1, b.h)],
      front: [P(b.x0, b.z1, b.h), P(b.x1, b.z1, b.h), P(b.x1, b.z1, 0), P(b.x0, b.z1, 0)],
      end: [P(b.x1, b.z0, b.h), P(b.x1, b.z1, b.h), P(b.x1, b.z1, 0), P(b.x1, b.z0, 0)],
      ribs,
    };
  };
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
      {line.belts.map((b) => {
        const g = strip(b);
        return (
          <g key={b.repo}>
            <polygon points={pts(g.front)} fill="#1c2230" stroke={INK} strokeWidth={0.6} />
            <polygon points={pts(g.end)} fill="#161b26" stroke={INK} strokeWidth={0.6} />
            <polygon points={pts(g.top)} fill="#2b3343" stroke={INK} strokeWidth={0.6} />
            {g.ribs.map(([p, q], i) => <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#3b4557" strokeWidth={1} />)}
          </g>
        );
      })}
      <g transform={`matrix(${fit.k} 0 0 ${fit.k} ${fit.ox} ${fit.oy})`}>
        {commits.map((c) => {
          const place = places.get(c.hash);
          if (!place) return null;
          const drop = fresh.includes(c), b = place.belt;
          // (a new one appears over its place on its repo's belt, and drops onto it)
          const at = iso(place.x, (b.z0 + b.z1) / 2, drop ? b.h + 3 * wu : b.h);
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
