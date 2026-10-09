"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import type { CityLayout } from "@/lib/city-layout";

/**
 * Agents City's world: the repos' cities on the flattened north pole of a
 * planet, under a starry sky. Everything is one mesh or one Points object,
 * shaded procedurally (no image assets); per frame only the twinkle time
 * and the slow sky rotation change.
 */

/** Direction of the sun (key light, sky glow, planet shading). */
export const SUN_DIR = new THREE.Vector3(0.55, 0.62, 0.38).normalize();
const SKY_R = 3000;

// 3D value noise + fbm, shared by the planet and sky shaders.
const NOISE = /* glsl */ `
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

/** Planet radius and the flat cap (plateau) radius for a city layout. */
export function planetFor(layout: CityLayout) {
  const cap = layout.size * 0.62 + 40; // covers every city with a margin
  const radius = Math.max(1600, cap * 9);
  return { radius, cap };
}

export function Planet({ layout }: { layout: CityLayout }) {
  const { radius, cap } = planetFor(layout);
  const capAngle = cap / radius;

  const planetMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uR: { value: radius },
          uCap: { value: capAngle },
          uSun: { value: SUN_DIR },
        },
        vertexShader: /* glsl */ `
          uniform float uR; uniform float uCap;
          varying vec3 vObj; varying vec3 vN; varying float vAng;
          void main() {
            vec3 n = normalize(position);
            float ang = acos(clamp(n.y, -1.0, 1.0));
            vec3 p = n * uR;
            // Flatten the polar cap into a plateau at y = uR (world y = 0), easing into the curve.
            float f = 1.0 - smoothstep(uCap * 0.92, uCap * 1.25, ang);
            p.y = mix(p.y, uR, f);
            vObj = n; vAng = ang;
            vN = normalize(mat3(modelMatrix) * mix(n, vec3(0.0, 1.0, 0.0), f));
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uCap; uniform vec3 uSun;
          varying vec3 vObj; varying vec3 vN; varying float vAng;
          ${NOISE}
          void main() {
            float h = fbm(vObj * 5.0 + 1.7);
            float land = smoothstep(0.47, 0.53, h);
            vec3 ocean = mix(vec3(0.015, 0.045, 0.11), vec3(0.03, 0.09, 0.2), fbm(vObj * 22.0));
            vec3 ground = mix(vec3(0.06, 0.08, 0.05), vec3(0.13, 0.11, 0.08), fbm(vObj * 34.0));
            ground = mix(ground, vec3(0.5, 0.52, 0.56), smoothstep(0.66, 0.74, h) * 0.35); // highlands
            vec3 col = mix(ocean, ground, land);
            // The cities' plateau: dark slate, with a soft rim.
            float plateau = 1.0 - smoothstep(uCap * 0.95, uCap * 1.12, vAng);
            // (Linear colour: the output pass converts to sRGB, so keep this very low to read near-black.)
            col = mix(col, vec3(0.006, 0.008, 0.013), plateau);
            float diff = max(dot(normalize(vN), uSun), 0.0);
            vec3 lit = col * (0.22 + 1.25 * diff);
            gl_FragColor = vec4(lit, 1.0);
          }`,
      }),
    [radius, capAngle],
  );

  const atmoMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uSun: { value: SUN_DIR }, uFade: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec3 vN; varying vec3 vView;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vView = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uSun; uniform float uFade; varying vec3 vN; varying vec3 vView;
          void main() {
            float rim = pow(1.0 - max(dot(vN, vView), 0.0), 3.5);
            float day = 0.35 + 0.65 * max(dot(vN, uSun), 0.0);
            float k = rim * day * uFade;
            gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * k * 1.8, k);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
      }),
    [],
  );

  useEffect(
    () => () => {
      planetMat.dispose();
      atmoMat.dispose();
    },
    [planetMat, atmoMat],
  );

  // The rim glow fades in only as the camera climbs (to see the limb), so it
  // never hazes over the cities in the normal close view.
  const camera = useThree((s) => s.camera);
  const atmo = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const u = (atmo.current?.material as THREE.ShaderMaterial | undefined)?.uniforms;
    if (!u) return;
    const alt = camera.position.y;
    u.uFade.value = THREE.MathUtils.smoothstep(alt, radius * 0.08, radius * 0.35);
  });

  return (
    <group position={[0, -radius, 0]}>
      <mesh material={planetMat}>
        <sphereGeometry args={[radius, 256, 160]} />
      </mesh>
      <mesh ref={atmo} material={atmoMat}>
        <sphereGeometry args={[radius * 1.03, 128, 64]} />
      </mesh>
    </group>
  );
}

/** Stars in three layers, biased toward the Milky Way band; one Points object. */
function makeStars() {
  const N = 6200;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const size = new Float32Array(N);
  const phase = new Float32Array(N);
  const band = new THREE.Vector3(0.25, 0.9, -0.35).normalize(); // band's pole
  const v = new THREE.Vector3();
  const tints = [new THREE.Color("#cfe0ff"), new THREE.Color("#ffffff"), new THREE.Color("#ffe9c7"), new THREE.Color("#ffd2b0")];
  for (let i = 0; i < N; i++) {
    // 35% near the band, the rest uniform on the sphere.
    for (;;) {
      v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      const l = v.length();
      if (l > 0.05 && l <= 1) break;
    }
    v.normalize();
    if (i % 100 < 35) {
      v.addScaledVector(band, -v.dot(band) * (0.85 + Math.random() * 0.15)).normalize();
    }
    v.multiplyScalar(SKY_R * 0.93);
    pos.set([v.x, v.y, v.z], i * 3);
    const layer = i < 200 ? 2 : i < 1500 ? 1 : 0;
    const bright = layer === 2 ? 1.8 + Math.random() * 1.2 : layer === 1 ? 0.8 + Math.random() * 0.5 : 0.35 + Math.random() * 0.45;
    const c = tints[Math.floor(Math.random() * tints.length)].clone().multiplyScalar(bright);
    col.set([c.r, c.g, c.b], i * 3);
    size[i] = layer === 2 ? 3 + Math.random() * 1.6 : layer === 1 ? 1.9 + Math.random() * 0.8 : 1.1 + Math.random() * 0.6;
    phase[i] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
  return geo;
}

export function SkyDome({ reduced }: { reduced: boolean }) {
  const group = useRef<THREE.Group>(null);
  const points = useRef<THREE.Points>(null);
  const camera = useThree((s) => s.camera);
  const dpr = useThree((s) => s.viewport.dpr);

  const skyMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uSun: { value: SUN_DIR } },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() { vDir = normalize(mat3(modelMatrix) * position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uSun; varying vec3 vDir;
          ${NOISE}
          void main() {
            vec3 d = normalize(vDir);
            vec3 base = mix(vec3(0.004, 0.006, 0.016), vec3(0.012, 0.018, 0.04), smoothstep(-0.3, 0.7, d.y));
            vec3 bandN = normalize(vec3(0.25, 0.9, -0.35));
            float band = exp(-pow(dot(d, bandN) / 0.2, 2.0));
            float n = fbm(d * 4.0) * 0.6 + fbm(d * 15.0) * 0.4;
            vec3 mw = mix(vec3(0.09, 0.08, 0.14), vec3(0.17, 0.14, 0.11), fbm(d * 8.0 + 2.0));
            mw *= band * (0.3 + 0.7 * smoothstep(0.35, 0.85, n));
            mw *= 1.0 - 0.65 * band * smoothstep(0.52, 0.72, fbm(d * 12.0 + 5.0)); // dust lanes
            float s = max(dot(d, uSun), 0.0);
            vec3 sun = vec3(1.0, 0.92, 0.78) * (pow(s, 900.0) * 6.0 + pow(s, 60.0) * 0.06 + pow(s, 8.0) * 0.015);
            gl_FragColor = vec4(base + mw * 0.6 + sun, 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    [],
  );

  const stars = useMemo(() => makeStars(), []);
  const starMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uTwinkle: { value: 1 }, uDpr: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute float size; attribute float phase; attribute vec3 color;
          uniform float uTime; uniform float uTwinkle; uniform float uDpr;
          varying vec3 vColor;
          void main() {
            float tw = 1.0 - uTwinkle * 0.4 * (0.5 + 0.5 * sin(uTime * (1.2 + fract(phase) * 2.5) + phase * 7.0));
            vColor = color * tw;
            gl_PointSize = size * uDpr;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.0, d);
            gl_FragColor = vec4(vColor * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useEffect(
    () => () => {
      skyMat.dispose();
      starMat.dispose();
      stars.dispose();
    },
    [skyMat, starMat, stars],
  );

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;
    // The sky travels with the camera, so it can never be left or clipped.
    g.position.copy(camera.position);
    if (!reduced) g.rotation.y += dt * 0.004;
    const u = (points.current?.material as THREE.ShaderMaterial | undefined)?.uniforms;
    if (u) {
      u.uTime.value = reduced ? 0 : state.clock.elapsedTime;
      u.uTwinkle.value = reduced ? 0 : 1;
      u.uDpr.value = dpr;
    }
  });

  return (
    <group ref={group}>
      <mesh material={skyMat} renderOrder={-10}>
        <sphereGeometry args={[SKY_R, 64, 32]} />
      </mesh>
      <points ref={points} geometry={stars} material={starMat} renderOrder={-9} frustumCulled={false} />
      <RingedPlanet />
    </group>
  );
}

/** A distant ringed planet as a landmark in the sky. */
function RingedPlanet() {
  const dir = useMemo(() => new THREE.Vector3(-0.62, 0.32, -0.71).normalize().multiplyScalar(SKY_R * 0.8), []);
  return (
    <group position={dir.toArray()} rotation={[0.35, 0.4, 0.25]}>
      <mesh>
        <sphereGeometry args={[95, 48, 32]} />
        <meshStandardMaterial color="#c8a36e" emissive="#3a2a18" emissiveIntensity={0.35} roughness={0.9} fog={false} />
      </mesh>
      <mesh rotation={[Math.PI / 2.2, 0, 0]}>
        <ringGeometry args={[130, 215, 96]} />
        <meshStandardMaterial color="#d9c49c" transparent opacity={0.45} side={THREE.DoubleSide} roughness={1} fog={false} />
      </mesh>
    </group>
  );
}

/** A warm key light like a distant sun, a cooler fill, and a dim ambient. */
export function WorldLights() {
  const sun = useMemo(() => SUN_DIR.clone().multiplyScalar(400), []);
  return (
    <>
      <ambientLight intensity={0.22} />
      <hemisphereLight args={["#8fa8ff", "#140f0a", 0.35]} />
      <directionalLight position={sun.toArray()} intensity={1.7} color="#fff1db" />
      <directionalLight position={[-sun.x, sun.y * 0.4, -sun.z]} intensity={0.45} color="#7aa2ff" />
    </>
  );
}
