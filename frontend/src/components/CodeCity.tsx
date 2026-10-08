import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { cn } from '@/lib/utils'
import { useModelPalette } from '../palette'

/**
 * A repository as a neon city at night. Each file is a plot of dark glass, each function,
 * method or class a glass tower as tall as its code is long, with edges and windows lit in
 * its kind's colour. Calls are arcs between rooftops; the streets are wet, so the city is
 * reflected in them. Selecting a tower lights it and its calls, flies the camera to it,
 * raises a beam from its roof and dims the rest; in impact mode the affected towers pulse in
 * waves, one hop at a time.
 */

export interface CityNode {
  id: string
  name?: string
  kind: string
  filepath?: string | null
  lines?: number
}
export interface CityEdge { source: string; target: string; type: string }

interface Props {
  nodes: CityNode[]
  edges: CityEdge[]
  selected?: string | null
  highlight?: Set<string> | null
  /** Symbol id → hops from the changed symbol: those towers pulse outward in waves. */
  pulse?: Map<string, number> | null
  onSelect?: (id: string | null) => void
  /** Drag to orbit and wheel to zoom. Off for the hero, where the mouse tilts it instead. */
  controls?: boolean
  /** Passes the light from one well-connected tower to the next while nothing is selected. */
  tour?: boolean
  /** Shifts the city sideways in frame (fraction of the width), to leave room for copy. */
  offsetX?: number
  /** Multiplies the framing distance: >1 shows more margin around the city. */
  framing?: number
  /** Floats the biggest folders' names above their part of the city. */
  districts?: boolean
  className?: string
}

interface Tower { node: CityNode; x: number; z: number; h: number; w: number }
interface District { name: string; x: number; z: number; count: number }

const CITY = {
  body: 0x1a1440, // tower glass, before its neon edges and windows
  plot: 0x1b1540,
  plotEdge: 0x4a3c8c,
  grid: 0x221b4a,
  gridMajor: 0x3a2f6e,
  horizon: 0x3b2477,
}

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

export function layoutCity(nodes: CityNode[]) {
  const byFile = new Map<string, CityNode[]>()
  nodes.forEach((n) => {
    const f = n.filepath ?? '(unknown)'
    if (!byFile.has(f)) byFile.set(f, [])
    byFile.get(f)!.push(n)
  })
  const files = [...byFile.keys()].sort()
  const blocks = files.map((f) => {
    const items = byFile.get(f)!.sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))
    const n = Math.ceil(Math.sqrt(items.length))
    return { file: f, items, n, size: n + 0.5 }
  })

  // Shelf-pack the file plots into a roughly square city; a new directory leaves a wider street.
  const area = blocks.reduce((s, b) => s + (b.size + 1) ** 2, 0)
  const maxW = Math.max(Math.sqrt(area) * 1.15, 6)
  const towers: Tower[] = []
  const plots: { x: number; z: number; size: number; file: string; count: number }[] = []
  let x = 0, z = 0, rowH = 0, prevDir: string | null = null
  blocks.forEach((b) => {
    const dir = dirname(b.file)
    if (prevDir !== null && dir !== prevDir) x += 1.2
    if (x + b.size > maxW && x > 0) { x = 0; z += rowH + 1; rowH = 0 }
    plots.push({ x: x + b.size / 2, z: z + b.size / 2, size: b.size, file: b.file, count: b.items.length })
    b.items.forEach((node, i) => {
      const lines = Math.max(node.lines ?? 6, 1)
      towers.push({
        node,
        x: x + 0.75 + (i % b.n),
        z: z + 0.75 + Math.floor(i / b.n),
        h: Math.min(0.35 + Math.sqrt(lines) * 0.42, 9),
        w: node.kind === 'class' ? 0.82 : node.kind === 'method' ? 0.58 : 0.66,
      })
    })
    x += b.size + 1
    rowH = Math.max(rowH, b.size)
    prevDir = dir
  })
  const width = Math.max(...plots.map((p) => p.x + p.size / 2), 1)
  const depth = Math.max(...plots.map((p) => p.z + p.size / 2), 1)
  towers.forEach((t) => { t.x -= width / 2; t.z -= depth / 2 })
  plots.forEach((p) => { p.x -= width / 2; p.z -= depth / 2 })

  // Districts: folders one level below whatever every file shares, weighted by symbols.
  const parts = files.map((f) => f.split('/'))
  let common = 0
  while (parts.length && parts.every((p) => p.length > common + 1 && p[common] === parts[0][common])) common++
  const groups = new Map<string, { sx: number; sz: number; count: number }>()
  plots.forEach((p) => {
    const segs = p.file.split('/')
    const key = segs.length > common + 1 ? segs.slice(0, common + 1).join('/') : '(top level)'
    const g = groups.get(key) ?? { sx: 0, sz: 0, count: 0 }
    g.sx += p.x * p.count; g.sz += p.z * p.count; g.count += p.count
    groups.set(key, g)
  })
  const districts: District[] = [...groups.entries()]
    .filter(([, g]) => g.count > 0)
    .map(([name, g]) => ({ name: name.split('/').pop() ?? name, x: g.sx / g.count, z: g.sz / g.count, count: g.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  return { towers, plots, districts, radius: Math.hypot(width, depth) / 2 }
}

/** A point on the arc from rooftop a to rooftop b; arcs rise with the distance they span. */
function arcPoint(a: Tower, b: Tower, t: number, out: THREE.Vector3) {
  const span = Math.hypot(b.x - a.x, b.z - a.z)
  const lift = 1.2 + span * 0.38
  const y0 = a.h, y1 = b.h
  const top = Math.max(y0, y1) + lift
  const u = 1 - t
  out.set(a.x + (b.x - a.x) * t, u * u * y0 + 2 * u * t * top + t * t * y1, a.z + (b.z - a.z) * t)
  return out
}

const ARC_SEGMENTS = 16
const MAX_LIT = 80
const TRAFFIC = 56

// Glass towers: a dark body with neon edges, a lit roof and a grid of windows, some on.
// Edge and window sizes are in world units, so thin and tall towers read the same.
const TOWER_VERT = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vScale;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vSeed;
  varying float vDepth;
  void main() {
    vLocal = position;
    vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vNormal = normal;
    vColor = instanceColor;
    vSeed = float(gl_InstanceID);
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`

const TOWER_FRAG = /* glsl */ `
  uniform vec3 uBody;
  uniform vec3 uFog;
  uniform float uNear;
  uniform float uFar;
  uniform float uTime;
  varying vec3 vLocal;
  varying vec3 vScale;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vSeed;
  varying float vDepth;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 w = vLocal * vScale;
    vec3 n = abs(vNormal);
    vec2 uv; vec2 size;
    if (n.y > 0.5) { uv = w.xz + vScale.xz * 0.5; size = vScale.xz; }
    else if (n.x > 0.5) { uv = vec2(w.z + vScale.z * 0.5, w.y); size = vScale.zy; }
    else { uv = vec2(w.x + vScale.x * 0.5, w.y); size = vScale.xy; }
    vec2 d = min(uv, size - uv);
    float edge = 1.0 - smoothstep(0.012, 0.04, min(d.x, d.y));

    vec3 col = uBody;
    if (n.y < 0.5) {
      // Faces turned away from the moonlight are darker, so towers read as volumes.
      col *= (vNormal.x > 0.5 || vNormal.z < -0.5) ? 0.75 : 1.0;
      vec2 cellSize = vec2(0.15, 0.26);
      vec2 cell = floor(uv / cellSize);
      vec2 f = fract(uv / cellSize);
      float win = step(0.28, f.x) * step(f.x, 0.72) * step(0.32, f.y) * step(f.y, 0.68);
      float on = step(0.58, hash(cell + vSeed * 3.17));
      float flicker = 0.7 + 0.3 * sin(uTime * 1.3 + hash(cell + vSeed) * 40.0);
      float margin = step(0.07, d.x) * step(0.1, d.y);
      col += vColor * win * on * flicker * margin * 0.5;
      // A soft glow pooling at the foot of every tower.
      col += vColor * 0.12 * (1.0 - smoothstep(0.0, 1.0, uv.y));
      // A thin band of light sweeping up the facade now and then.
      float band = smoothstep(0.05, 0.0, abs(fract(uv.y * 0.08 - uTime * 0.05 + vSeed * 0.37) - 0.5));
      col += vColor * band * 0.25;
    } else {
      col += vColor * 0.34;
    }
    col = mix(col, vColor * 1.3, edge);
    // Far towers glow less, so a large city reads as a skyline rather than a haze.
    col = mix(uBody, col, 1.0 - 0.55 * smoothstep(uNear * 0.6, uFar, vDepth));
    float fog = smoothstep(uNear, uFar, vDepth);
    gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
  }`

// Night sky: a violet glow on the horizon, fading to the ground colour overhead.
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`
const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  varying vec3 vDir;
  void main() {
    // Only above the horizon: below it the sky must match the ground, or the street's edge shows.
    float glow = vDir.y >= 0.0 ? exp(-vDir.y * 6.0) : exp(vDir.y * 60.0);
    gl_FragColor = vec4(mix(uTop, uHorizon, glow * 0.85), 1.0);
  }`

function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.3, 'rgba(255,255,255,0.8)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

/**
 * Fades the reflective street into the night. Clear inside `inner`, solid ground colour from
 * `outer` (both as fractions of the plane's half-size), so the mirror's edge never shows.
 */
function vignetteTexture(color: number, inner: number, outer: number) {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')!
  const col = new THREE.Color(color)
  const rgb = `${Math.round(col.r * 255)}, ${Math.round(col.g * 255)}, ${Math.round(col.b * 255)}`
  const g = ctx.createRadialGradient(128, 128, 128 * inner, 128, 128, 128 * outer)
  g.addColorStop(0, `rgba(${rgb}, 0)`)
  g.addColorStop(0.5, `rgba(${rgb}, 0.55)`)
  g.addColorStop(1, `rgba(${rgb}, 1)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export default function CodeCity({
  nodes, edges, selected = null, highlight = null, pulse = null, onSelect, controls = true, tour = false,
  offsetX = 0, framing = 1, districts = false, className,
}: Props) {
  const pal = useModelPalette()
  const mountRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const districtRefs = useRef<(HTMLDivElement | null)[]>([])
  const apiRef = useRef<{ focus: (sel: string | null, hl: Set<string> | null) => void; reframe: () => void; repaint: () => void } | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const [hover, setHover] = useState<CityNode | null>(null)
  const [districtList, setDistrictList] = useState<District[]>([])
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const offsetRef = useRef(offsetX)
  offsetRef.current = offsetX
  const pulseRef = useRef(pulse)
  pulseRef.current = pulse

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || nodes.length === 0) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(pal.ground)
    const fog = new THREE.Fog(pal.ground, 40, 140)
    scene.fog = fog
    const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 2000)
    const disposables: { dispose(): void }[] = []
    const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x)

    const { towers, plots, districts: districtData, radius } = layoutCity(nodes)
    setDistrictList(districts ? districtData : [])

    // Bloom turns the neon edges, windows, arcs and their reflections into light.
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.95 * THREE.MathUtils.clamp(16 / radius, 0.45, 1), 0.55, 0.28)
    composer.addPass(bloom)
    composer.addPass(new OutputPass())

    const indexOf = new Map(towers.map((t, i) => [t.node.id, i]))
    const links = edges
      .map((e) => ({ a: indexOf.get(e.source), b: indexOf.get(e.target), type: e.type }))
      .filter((l): l is { a: number; b: number; type: string } => l.a !== undefined && l.b !== undefined && l.a !== l.b)
    // Membership edges are implied by the plots; only calls and inheritance are drawn as arcs.
    const arcs = links.filter((l) => l.type !== 'HAS_METHOD')

    // --- sky --------------------------------------------------------------------------------
    const skyMat = keep(new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTop: { value: new THREE.Color(pal.ground) }, uHorizon: { value: new THREE.Color(CITY.horizon) } },
    }))
    const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(radius * 14 + 300, 32, 16)), skyMat)
    scene.add(sky)

    // --- wet streets: a real mirror under the city, fading into the night at its rim --------
    const streetSize = radius * 3.2 + 14
    const pr = renderer.getPixelRatio()
    const mirror = new Reflector(keep(new THREE.PlaneGeometry(streetSize, streetSize)), {
      textureWidth: 512,
      textureHeight: 512,
      color: 0x3d3566,
      clipBias: 0.003,
    })
    mirror.rotation.x = -Math.PI / 2
    mirror.position.y = -0.03
    scene.add(mirror)
    // Twice the street's size: clear around the city, solid ground before the mirror ends.
    const vignetteSize = streetSize * 2
    const vignette = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(vignetteSize, vignetteSize)),
      keep(new THREE.MeshBasicMaterial({
        map: keep(vignetteTexture(pal.ground, (radius * 1.15) / (vignetteSize / 2), (streetSize * 0.46) / (vignetteSize / 2))),
        transparent: true,
        depthWrite: false,
        fog: false,
      })),
    )
    vignette.rotation.x = -Math.PI / 2
    vignette.position.y = -0.02
    scene.add(vignette)

    const grid = new THREE.GridHelper(Math.ceil(streetSize), Math.ceil(streetSize), CITY.gridMajor, CITY.grid)
    grid.position.y = -0.01
    const gridMat = grid.material as THREE.LineBasicMaterial
    gridMat.transparent = true
    gridMat.opacity = 0.5
    keep(grid.geometry); keep(gridMat)
    scene.add(grid)

    // File plots: dark glass, so the reflections still show through.
    const slabMat = keep(new THREE.MeshBasicMaterial({ color: CITY.plot, transparent: true, opacity: 0.45 }))
    const slabs = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(1, 0.08, 1)), slabMat, plots.length)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    plots.forEach((p, i) => slabs.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, 0.04, p.z), q, new THREE.Vector3(p.size, 1, p.size))))
    scene.add(slabs)

    const outline = new Float32Array(plots.length * 24)
    plots.forEach((p, i) => {
      const h = p.size / 2, y = 0.09
      const c = [[-h, -h], [h, -h], [h, h], [-h, h]]
      c.forEach(([ax, az], k) => {
        const [bx, bz] = c[(k + 1) % 4]
        outline.set([p.x + ax, y, p.z + az, p.x + bx, y, p.z + bz], i * 24 + k * 6)
      })
    })
    const outlineGeo = keep(new THREE.BufferGeometry())
    outlineGeo.setAttribute('position', new THREE.BufferAttribute(outline, 3))
    const outlineMat = keep(new THREE.LineBasicMaterial({ color: CITY.plotEdge, transparent: true, opacity: 0.85 }))
    scene.add(new THREE.LineSegments(outlineGeo, outlineMat))

    // --- towers -----------------------------------------------------------------------------
    const towerGeo = keep(new THREE.BoxGeometry(1, 1, 1))
    towerGeo.translate(0, 0.5, 0)
    const towerMat = keep(new THREE.ShaderMaterial({
      vertexShader: TOWER_VERT,
      fragmentShader: TOWER_FRAG,
      uniforms: {
        uBody: { value: new THREE.Color(CITY.body) },
        uFog: { value: new THREE.Color(pal.ground) },
        uNear: { value: 40 },
        uFar: { value: 140 },
        uTime: { value: 0 },
      },
    }))
    const city = new THREE.InstancedMesh(towerGeo, towerMat, towers.length)
    const base = towers.map((t) => new THREE.Color(pal.kinds[t.node.kind] ?? pal.pencil))
    // tint: each tower's colour after selection and highlight; hover and pulses multiply on top.
    const tint = base.map((c) => c.clone())
    const rise = new Float32Array(towers.length) // 0..1 build-up on first appearance
    const lift = new Float32Array(towers.length) // 0..1 hover lift
    const setTower = (i: number) => {
      const t = towers[i]
      const g = 1 - (1 - rise[i]) ** 3
      m.compose(new THREE.Vector3(t.x, 0.08, t.z), q, new THREE.Vector3(t.w, Math.max(t.h * g * (1 + lift[i] * 0.1), 0.001), t.w))
      city.setMatrixAt(i, m)
    }
    towers.forEach((_, i) => { rise[i] = reduceMotion ? 1 : 0; setTower(i); city.setColorAt(i, base[i]) })
    scene.add(city)

    // --- arcs: a faint layer for every call, and lit tubes for the focused tower -------------
    const faintPos = new Float32Array(arcs.length * ARC_SEGMENTS * 6)
    const faintCol = new Float32Array(arcs.length * ARC_SEGMENTS * 6)
    const faintGeo = keep(new THREE.BufferGeometry())
    faintGeo.setAttribute('position', new THREE.BufferAttribute(faintPos, 3))
    faintGeo.setAttribute('color', new THREE.BufferAttribute(faintCol, 3))
    const faintBase = THREE.MathUtils.clamp(0.32 * Math.sqrt(160 / Math.max(arcs.length, 1)), 0.1, 0.32)
    const faintMat = keep(new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: faintBase, depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    scene.add(new THREE.LineSegments(faintGeo, faintMat))

    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3()
    const col = new THREE.Color()
    const paintFaint = (only: Set<number> | null) => {
      arcs.forEach((l, k) => {
        col.setHex(pal.edges[l.type] ?? pal.thread)
        if (only && !(only.has(l.a) && only.has(l.b))) col.multiplyScalar(0.12)
        for (let s = 0; s < ARC_SEGMENTS; s++) {
          const o = (k * ARC_SEGMENTS + s) * 6
          arcPoint(towers[l.a], towers[l.b], s / ARC_SEGMENTS, p0).toArray(faintPos, o)
          arcPoint(towers[l.a], towers[l.b], (s + 1) / ARC_SEGMENTS, p1).toArray(faintPos, o + 3)
          col.toArray(faintCol, o)
          col.toArray(faintCol, o + 3)
        }
      })
      faintGeo.attributes.position.needsUpdate = true
      faintGeo.attributes.color.needsUpdate = true
    }
    paintFaint(null)

    // Lit arcs are real tubes (WebGL lines are always 1px); colours above 1.0 pass the bloom threshold.
    const litGroup = new THREE.Group()
    scene.add(litGroup)
    const litMats = {
      CALLS: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.thread).multiplyScalar(1.8) })),
      INHERITS: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.edges.INHERITS).multiplyScalar(1.6) })),
    }
    const clearLit = () => {
      litGroup.children.forEach((c) => (c as THREE.Mesh).geometry.dispose())
      litGroup.clear()
    }
    const ctrl = new THREE.Vector3()
    const tubeFor = (a: Tower, b: Tower) => {
      const span = Math.hypot(b.x - a.x, b.z - a.z)
      ctrl.set((a.x + b.x) / 2, Math.max(a.h, b.h) + 1.2 + span * 0.38, (a.z + b.z) / 2)
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(a.x, a.h, a.z), ctrl.clone(), new THREE.Vector3(b.x, b.h, b.z))
      return new THREE.TubeGeometry(curve, 40, Math.max(0.06, radius * 0.003), 6, false)
    }

    // Beads: one per lit arc, travelling caller → callee.
    const beadMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(2.2) }))
    const beads = new THREE.InstancedMesh(keep(new THREE.SphereGeometry(0.18, 12, 10)), beadMat, MAX_LIT)
    beads.count = 0
    scene.add(beads)

    // Traffic: packets running along random calls while nothing is selected, so the city is alive.
    const glow = keep(glowTexture())
    const traffic = Array.from({ length: arcs.length ? TRAFFIC : 0 }, () => ({
      arc: Math.floor(Math.random() * arcs.length), t: Math.random(), speed: 0.25 + Math.random() * 0.35,
    }))
    const trafficPos = new Float32Array(traffic.length * 3)
    const trafficGeo = keep(new THREE.BufferGeometry())
    trafficGeo.setAttribute('position', new THREE.BufferAttribute(trafficPos, 3))
    const trafficMat = keep(new THREE.PointsMaterial({
      size: Math.max(0.5, radius * 0.024), map: glow, color: 0xe6dcff, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    const trafficPoints = new THREE.Points(trafficGeo, trafficMat)
    trafficPoints.visible = traffic.length > 0 && !reduceMotion
    scene.add(trafficPoints)

    // The selected tower gets a beam of light from its roof and a scan ring on the ground.
    const beamGeo = keep(new THREE.CylinderGeometry(0.05, 0.05, 1, 8, 1, true))
    beamGeo.translate(0, 0.5, 0)
    const beamMat = keep(new THREE.MeshBasicMaterial({
      color: new THREE.Color(pal.thread).multiplyScalar(1.4), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    const beam = new THREE.Mesh(beamGeo, beamMat)
    beam.visible = false
    scene.add(beam)
    const ringGeo = keep(new THREE.RingGeometry(0.92, 1, 64))
    ringGeo.rotateX(-Math.PI / 2)
    const ringMat = keep(new THREE.MeshBasicMaterial({
      color: new THREE.Color(pal.thread).multiplyScalar(1.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.position.y = 0.12
    ring.visible = false
    scene.add(ring)

    // --- colour: selection and highlight set the tint; hover and impact pulses multiply it ---
    const clock = new THREE.Clock()
    let hoverIdx = -1
    const paintTowers = () => {
      const pulses = pulseRef.current
      const t = clock.elapsedTime
      towers.forEach((tw, i) => {
        col.copy(tint[i])
        const hops = pulses?.get(tw.node.id)
        if (hops !== undefined && !reduceMotion) {
          // A wave leaving the changed symbol and reaching each hop in turn.
          const phase = (((t * 0.9 - hops * 0.42) % 1.8) + 1.8) % 1.8
          col.multiplyScalar(1 + 1.4 * Math.exp(-((phase * 5) ** 2)))
        }
        if (i === hoverIdx) col.multiplyScalar(1.5)
        city.setColorAt(i, col)
      })
      city.instanceColor!.needsUpdate = true
    }

    let lit: { a: number; b: number; type: string }[] = []
    let litGrow = 1
    let focusIdx = -1
    let focusAt = 0
    const focus = (sel: string | null, hl: Set<string> | null) => {
      focusIdx = sel ? indexOf.get(sel) ?? -1 : -1
      focusAt = clock.elapsedTime
      const near = new Set<number>()
      lit = []
      if (focusIdx >= 0) {
        near.add(focusIdx)
        links.forEach((l) => {
          if (l.a === focusIdx || l.b === focusIdx) {
            near.add(l.a); near.add(l.b)
            if (l.type !== 'HAS_METHOD' && lit.length < MAX_LIT) lit.push(l)
          }
        })
      }
      const hlIdx = hl && hl.size ? new Set([...hl].map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined)) : null
      const keepSet = focusIdx >= 0 ? (hlIdx ? new Set([...near, ...hlIdx]) : near) : hlIdx
      const dim = focusIdx >= 0 && tour ? 0.4 : 0.16
      towers.forEach((_, i) => {
        tint[i].copy(base[i])
        if (i === focusIdx) tint[i].setHex(pal.thread).multiplyScalar(1.5)
        else if (keepSet && !keepSet.has(i)) tint[i].multiplyScalar(dim)
      })
      paintTowers()
      paintFaint(keepSet)
      faintMat.opacity = focusIdx >= 0 ? faintBase * 0.6 : faintBase
      clearLit()
      lit.forEach((l) => {
        litGroup.add(new THREE.Mesh(tubeFor(towers[l.a], towers[l.b]), l.type === 'INHERITS' ? litMats.INHERITS : litMats.CALLS))
      })
      litGrow = reduceMotion ? 1 : 0
      beam.visible = ring.visible = focusIdx >= 0
      trafficPoints.visible = traffic.length > 0 && !reduceMotion && focusIdx < 0
      if (focusIdx >= 0) {
        const tw = towers[focusIdx]
        beam.position.set(tw.x, tw.h, tw.z)
        ring.position.x = tw.x
        ring.position.z = tw.z
      }
    }

    // --- camera ---------------------------------------------------------------------------------
    let yaw = 0.75, pitch = 0.72
    // Distance that fits the whole city in the narrower of the two fields of view.
    const fitDist = () => {
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      const tanH = tanV * camera.aspect
      return ((radius * 1.08) / Math.min(tanV * 1.3, tanH) + 6) * framing
    }
    let dist = 60, targetDist = dist, userZoomed = false
    const minD = Math.max(radius * 0.5, 8), maxD = radius * 8 + 60
    // The orbit centre glides to the selected tower and back (camera fly-to).
    const look = new THREE.Vector3(0, 1.5, 0)
    const lookTarget = new THREE.Vector3(0, 1.5, 0)
    let parallaxX = 0, parallaxY = 0, tiltX = 0, tiltY = 0
    let dragging = false, moved = false, lastX = 0, lastY = 0, idleSince = performance.now()
    const el = renderer.domElement
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const pick = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObject(city)[0]
      return hit?.instanceId !== undefined ? hit.instanceId : -1
    }
    const onMove = (e: PointerEvent) => {
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
        yaw -= dx * 0.006
        pitch = Math.max(0.18, Math.min(1.45, pitch + dy * 0.005))
        lastX = e.clientX; lastY = e.clientY
        return
      }
      const i = pick(e)
      if (i !== hoverIdx) {
        hoverIdx = i
        setHover(i >= 0 ? towers[i].node : null)
        paintTowers()
      }
      el.style.cursor = i >= 0 && onSelectRef.current ? 'pointer' : controls ? 'grab' : 'default'
    }
    const onLeave = () => { hoverIdx = -1; setHover(null); paintTowers() }
    const onDown = (e: PointerEvent) => {
      if (!controls) return
      dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY
      el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'
    }
    const onUp = (e: PointerEvent) => {
      dragging = false; idleSince = performance.now()
      if (!moved && onSelectRef.current) { const i = pick(e); onSelectRef.current(i >= 0 ? towers[i].node.id : null) }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      userZoomed = true
      targetDist = Math.max(minD, Math.min(maxD, targetDist * (1 + Math.sign(e.deltaY) * 0.1)))
    }
    // The hero has no controls: the mouse anywhere on the page tilts the city a little.
    const onWindowMove = (e: PointerEvent) => {
      parallaxX = (e.clientX / window.innerWidth - 0.5) * 0.35
      parallaxY = (e.clientY / window.innerHeight - 0.5) * 0.12
    }
    if (controls) el.style.touchAction = 'none'
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    if (controls) el.addEventListener('wheel', onWheel, { passive: false })
    if (!controls && !reduceMotion) window.addEventListener('pointermove', onWindowMove)

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount
      renderer.setSize(w, h, false)
      composer.setPixelRatio(renderer.getPixelRatio())
      composer.setSize(w, h)
      mirror.getRenderTarget().setSize(Math.max(256, Math.round(w * pr * 0.5)), Math.max(256, Math.round(h * pr * 0.5)))
      camera.aspect = w / Math.max(h, 1)
      // Wide screens push the city aside for the copy; portrait ones lift it above the copy.
      const shift = camera.aspect > 1.2 ? offsetRef.current : 0
      const raise = offsetRef.current && camera.aspect < 1 ? 0.2 : 0
      if (shift || raise) camera.setViewOffset(w, h, -shift * w, raise * h, w, h)
      else camera.clearViewOffset()
      camera.updateProjectionMatrix()
      if (!userZoomed && focusIdx < 0) targetDist = dist = Math.min(maxD, fitDist())
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()
    apiRef.current = { focus, reframe: resize, repaint: paintTowers }

    let visible = true
    const io = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    io.observe(mount)

    // Tour: hand the light from one well-connected tower to the next.
    const tourable = tour ? towers.map((_, i) => i).filter((i) => arcs.filter((l) => l.a === i).length >= 2) : []
    let tourAt = 0, tourStep = 0

    // --- loop -------------------------------------------------------------------------------------
    const tmp = new THREE.Vector3()
    let frame = 0
    const render = () => {
      frame = requestAnimationFrame(render)
      if (!visible) return
      const dt = Math.min(clock.getDelta(), 0.05)
      const t = clock.elapsedTime
      towerMat.uniforms.uTime.value = reduceMotion ? 0 : t

      // Towers rise in a wave from the city centre on first paint; the hovered one lifts.
      let moving = false
      towers.forEach((tw, i) => {
        const wantLift = i === hoverIdx ? 1 : 0
        if (rise[i] >= 1 && lift[i] === wantLift) return
        if (rise[i] < 1) {
          const delay = (Math.hypot(tw.x, tw.z) / (radius + 1)) * 0.9
          rise[i] = Math.min(1, Math.max(0, (t - delay) * 1.6))
        }
        lift[i] = reduceMotion ? wantLift : lift[i] + (wantLift - lift[i]) * Math.min(1, dt * 14)
        if (Math.abs(lift[i] - wantLift) < 0.01) lift[i] = wantLift
        setTower(i)
        moving = true
      })
      if (moving) { city.instanceMatrix.needsUpdate = true; city.computeBoundingSphere() }
      if (pulseRef.current?.size) paintTowers()

      if (tourable.length && !selectedRef.current && !reduceMotion && t > 1.6 && t - tourAt > 3.4) {
        tourAt = t
        focus(towers[tourable[(tourStep++ * 7) % tourable.length]].node.id, null)
      }

      // Lit arcs draw themselves outward, then carry a bead each.
      if (lit.length) {
        litGrow = Math.min(1, litGrow + dt * 1.8)
        litGroup.children.forEach((c) => {
          const g = (c as THREE.Mesh).geometry
          g.setDrawRange(0, Math.ceil((g.index!.count / 6) * litGrow) * 6)
        })
        beads.count = litGrow >= 1 && !reduceMotion ? lit.length : 0
        lit.forEach((l, k) => {
          arcPoint(towers[l.a], towers[l.b], (t * 0.55 + k * 0.13) % 1, tmp)
          beads.setMatrixAt(k, m.makeTranslation(tmp.x, tmp.y, tmp.z))
        })
        beads.instanceMatrix.needsUpdate = true
      } else {
        beads.count = 0
      }

      if (trafficPoints.visible) {
        traffic.forEach((p, k) => {
          p.t += dt * p.speed
          if (p.t > 1) { p.t = 0; p.arc = Math.floor(Math.random() * arcs.length) }
          const l = arcs[p.arc]
          arcPoint(towers[l.a], towers[l.b], p.t, tmp).toArray(trafficPos, k * 3)
        })
        trafficGeo.attributes.position.needsUpdate = true
      }

      if (focusIdx >= 0) {
        // The beam shoots up once, then the ring keeps scanning outwards.
        const since = t - focusAt
        beam.scale.set(1, reduceMotion ? 18 : Math.min(1, since * 2.5) * 18, 1)
        const cycle = reduceMotion ? 0.5 : (since % 2) / 2
        ring.scale.setScalar(0.6 + cycle * (2.5 + radius * 0.12))
        ringMat.opacity = 0.9 * (1 - cycle)
      }

      // Fly-to: glide the orbit centre to the selected tower (and closer), or back to the city.
      if (focusIdx >= 0 && controls) {
        const tw = towers[focusIdx]
        lookTarget.set(tw.x, tw.h * 0.6, tw.z)
        if (!userZoomed) targetDist = Math.max(minD, Math.min(fitDist() * 0.55, radius * 1.6 + 18))
      } else {
        lookTarget.set(0, 1.5, 0)
        if (!userZoomed) targetDist = Math.min(maxD, fitDist())
      }
      look.lerp(lookTarget, reduceMotion ? 1 : Math.min(1, dt * 3))

      if (!dragging && !reduceMotion && performance.now() - idleSince > 1200) yaw += dt * 0.05
      tiltX += (parallaxX - tiltX) * Math.min(1, dt * 3)
      tiltY += (parallaxY - tiltY) * Math.min(1, dt * 3)
      dist += (targetDist - dist) * 0.1
      fog.near = dist * 0.9
      fog.far = dist * 2.4
      towerMat.uniforms.uNear.value = fog.near
      towerMat.uniforms.uFar.value = fog.far
      const y = yaw + tiltX, p = Math.max(0.15, pitch + tiltY)
      camera.position.set(look.x + Math.sin(y) * Math.cos(p) * dist, look.y + Math.sin(p) * dist, look.z + Math.cos(y) * Math.cos(p) * dist)
      camera.lookAt(look)
      composer.render()

      const label = labelRef.current
      if (label) {
        if (hoverIdx >= 0) {
          const tw = towers[hoverIdx]
          tmp.set(tw.x, tw.h, tw.z).project(camera)
          label.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * mount.clientWidth}px, ${(-tmp.y * 0.5 + 0.5) * mount.clientHeight}px)`
          label.style.opacity = '1'
        } else label.style.opacity = '0'
      }
      if (districts) {
        districtData.forEach((d, k) => {
          const node = districtRefs.current[k]
          if (!node) return
          tmp.set(d.x, 0.2, d.z).project(camera)
          node.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * mount.clientWidth}px, ${(-tmp.y * 0.5 + 0.5) * mount.clientHeight}px)`
          node.style.opacity = tmp.z > 1 || focusIdx >= 0 ? '0' : '1'
        })
      }
    }
    render()

    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      io.disconnect()
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointermove', onWindowMove)
      disposables.forEach((x) => x.dispose())
      clearLit()
      city.dispose(); slabs.dispose(); beads.dispose()
      mirror.dispose()
      bloom.dispose()
      composer.dispose()
      renderer.dispose()
      mount.removeChild(el)
      apiRef.current = null
    }
    // The city is rebuilt only when the graph itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, pal, districts])

  useEffect(() => {
    apiRef.current?.focus(selected, highlight)
  }, [selected, highlight, nodes, edges, pal])

  // A pulse that ends must clear its glow.
  useEffect(() => {
    apiRef.current?.repaint()
  }, [pulse])

  // Reframe (without rebuilding) when the requested offset changes.
  useEffect(() => {
    apiRef.current?.reframe()
  }, [offsetX])

  return (
    <div className={cn('relative overflow-hidden', className)}>
      <div ref={mountRef} className="absolute inset-0 [&>canvas]:block [&>canvas]:size-full" />
      {districtList.map((d, k) => (
        <div
          key={d.name + k}
          ref={(node) => { districtRefs.current[k] = node }}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 z-[5] opacity-0 transition-opacity duration-300"
        >
          <span className="block -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-thread/30 bg-[#140f2e]/70 px-2.5 py-0.5 font-mono text-[0.7rem] text-thread shadow-[0_0_14px_rgb(177_140_255/0.25)] backdrop-blur-sm">
            {d.name}
          </span>
        </div>
      ))}
      <div ref={labelRef} aria-hidden className="pointer-events-none absolute left-0 top-0 z-10 opacity-0 transition-opacity duration-150">
        {hover && (
          <div className="-translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-md border border-thread/40 bg-popover/95 px-2.5 py-1.5 shadow-[0_0_20px_rgb(177_140_255/0.25)] backdrop-blur">
            <div className="font-mono text-[0.78rem] font-medium">{hover.name ?? hover.id}</div>
            <div className="font-mono text-[0.7rem] text-muted-foreground">
              {hover.filepath}
              {hover.lines ? <span className="font-sans">, {hover.lines} lines</span> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
