import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { CITY, EDGE_COLORS, KIND_COLORS } from '../palette'

/**
 * A repository as a neon city. Each file is a plot, each function/class/method a glass tower
 * whose height follows its line count, with edges and windows lit in its kind's colour.
 * Call edges are arcs between rooftops. Selecting a tower lights it and its calls in violet,
 * raises a beam from its roof and dims the rest of the city.
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
  onSelect?: (id: string | null) => void
  /** Drag to orbit and wheel to zoom. Off for the hero, where it would trap page scroll. */
  controls?: boolean
  /** Cycles a lit "query" through the city when nothing is selected. */
  tour?: boolean
  /** Shifts the city sideways in frame (fraction of the width), to leave room for overlaid copy. */
  offsetX?: number
  className?: string
}

interface Tower { node: CityNode; x: number; z: number; h: number; w: number }

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

function layoutCity(nodes: CityNode[]) {
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
  const plots: { x: number; z: number; size: number }[] = []
  let x = 0, z = 0, rowH = 0, prevDir: string | null = null
  blocks.forEach((b) => {
    const dir = dirname(b.file)
    if (prevDir !== null && dir !== prevDir) x += 1.2
    if (x + b.size > maxW && x > 0) { x = 0; z += rowH + 1; rowH = 0 }
    plots.push({ x: x + b.size / 2, z: z + b.size / 2, size: b.size })
    b.items.forEach((node, i) => {
      const cx = x + 0.75 + (i % b.n)
      const cz = z + 0.75 + Math.floor(i / b.n)
      const lines = Math.max(node.lines ?? 6, 1)
      towers.push({
        node,
        x: cx,
        z: cz,
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
  return { towers, plots, radius: Math.hypot(width, depth) / 2 }
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
      vec2 cellSize = vec2(0.15, 0.26);
      vec2 cell = floor(uv / cellSize);
      vec2 f = fract(uv / cellSize);
      float win = step(0.28, f.x) * step(f.x, 0.72) * step(0.32, f.y) * step(f.y, 0.68);
      float on = step(0.58, hash(cell + vSeed * 3.17));
      float flicker = 0.7 + 0.3 * sin(uTime * 1.3 + hash(cell + vSeed) * 40.0);
      float margin = step(0.07, d.x) * step(0.1, d.y);
      col += vColor * win * on * flicker * margin * 0.5;
      // A soft glow pooling at the foot of every tower.
      col += vColor * 0.1 * (1.0 - smoothstep(0.0, 1.0, uv.y));
    } else {
      col += vColor * 0.32;
    }
    col = mix(col, vColor * 1.3, edge);
    // Far towers glow less, so a large city reads as a skyline rather than a haze.
    col = mix(uBody, col, 1.0 - 0.55 * smoothstep(uNear * 0.6, uFar, vDepth));
    float fog = smoothstep(uNear, uFar, vDepth);
    gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
  }`

export default function CodeCity({
  nodes, edges, selected = null, highlight = null, onSelect, controls = true, tour = false, offsetX = 0, className,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<{ focus: (sel: string | null, hl: Set<string> | null) => void } | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const [hover, setHover] = useState<CityNode | null>(null)
  // The tour must stand down while the user has something selected.
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || nodes.length === 0) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(CITY.ground)
    const fog = new THREE.Fog(CITY.ground, 40, 140)
    scene.fog = fog
    const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 600)
    const disposables: { dispose(): void }[] = []
    const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x)

    // Bloom turns the neon edges, windows and arcs into light.
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const { towers, plots, radius } = layoutCity(nodes)
    // Big cities have far more lit pixels, so they get less bloom.
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9 * THREE.MathUtils.clamp(16 / radius, 0.45, 1), 0.5, 0.3)
    composer.addPass(bloom)
    composer.addPass(new OutputPass())

    const indexOf = new Map(towers.map((t, i) => [t.node.id, i]))
    const links = edges
      .map((e) => ({ a: indexOf.get(e.source), b: indexOf.get(e.target), type: e.type }))
      .filter((l): l is { a: number; b: number; type: string } => l.a !== undefined && l.b !== undefined && l.a !== l.b)
    // Membership edges are implied by the plots; only calls and inheritance are drawn as arcs.
    const arcs = links.filter((l) => l.type !== 'HAS_METHOD')

    // --- ground: a neon street grid, and one outlined plot per file --------------------
    const grid = new THREE.GridHelper(Math.ceil(radius * 4), Math.ceil(radius * 4), CITY.gridMajor, CITY.grid)
    grid.position.y = -0.02
    keep(grid.geometry); keep(grid.material as THREE.Material)
    scene.add(grid)

    const slabGeo = keep(new THREE.BoxGeometry(1, 0.08, 1))
    const slabMat = keep(new THREE.MeshBasicMaterial({ color: CITY.plot }))
    const slabs = new THREE.InstancedMesh(slabGeo, slabMat, plots.length)
    const m = new THREE.Matrix4()
    plots.forEach((p, i) => slabs.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, 0.04, p.z), new THREE.Quaternion(), new THREE.Vector3(p.size, 1, p.size))))
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
    const outlineMat = keep(new THREE.LineBasicMaterial({ color: CITY.plotEdge, transparent: true, opacity: 0.8 }))
    scene.add(new THREE.LineSegments(outlineGeo, outlineMat))

    // --- towers ----------------------------------------------------------------------
    const towerGeo = keep(new THREE.BoxGeometry(1, 1, 1))
    towerGeo.translate(0, 0.5, 0)
    const towerMat = keep(new THREE.ShaderMaterial({
      vertexShader: TOWER_VERT,
      fragmentShader: TOWER_FRAG,
      uniforms: {
        uBody: { value: new THREE.Color(CITY.body) },
        uFog: { value: new THREE.Color(CITY.ground) },
        uNear: { value: 40 },
        uFar: { value: 140 },
        uTime: { value: 0 },
      },
    }))
    const city = new THREE.InstancedMesh(towerGeo, towerMat, towers.length)
    const base = towers.map((t) => new THREE.Color(KIND_COLORS[t.node.kind] ?? CITY.unknown))
    const rise = new Float32Array(towers.length) // 0..1 build-up on first appearance
    const setTower = (i: number, grow: number) => {
      const t = towers[i]
      m.compose(new THREE.Vector3(t.x, 0.08, t.z), new THREE.Quaternion(), new THREE.Vector3(t.w, Math.max(t.h * grow, 0.001), t.w))
      city.setMatrixAt(i, m)
    }
    towers.forEach((_, i) => { rise[i] = reduceMotion ? 1 : 0; setTower(i, rise[i]); city.setColorAt(i, base[i]) })
    scene.add(city)

    // --- arcs: a faint layer for every call, and lit tubes for the focused tower ---------
    const faintPos = new Float32Array(arcs.length * ARC_SEGMENTS * 6)
    const faintCol = new Float32Array(arcs.length * ARC_SEGMENTS * 6)
    const faintGeo = keep(new THREE.BufferGeometry())
    faintGeo.setAttribute('position', new THREE.BufferAttribute(faintPos, 3))
    faintGeo.setAttribute('color', new THREE.BufferAttribute(faintCol, 3))
    const faintMat = keep(new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    scene.add(new THREE.LineSegments(faintGeo, faintMat))

    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3()
    const col = new THREE.Color()
    const paintFaint = (only: Set<number> | null) => {
      arcs.forEach((l, k) => {
        col.setHex(EDGE_COLORS[l.type] ?? CITY.unknown)
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

    // Lit arcs are real tubes (WebGL lines are always 1px), rebuilt whenever the focus moves.
    // Colours above 1.0 push them past the bloom threshold.
    const MAX_LIT = 80
    const litGroup = new THREE.Group()
    scene.add(litGroup)
    const litMats = {
      CALLS: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(CITY.lit).multiplyScalar(1.8) })),
      INHERITS: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(EDGE_COLORS.INHERITS).multiplyScalar(1.6) })),
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

    // Pulses: one bead per lit arc, travelling caller → callee.
    const beadGeo = keep(new THREE.SphereGeometry(0.18, 12, 10))
    const beadMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(2.2) }))
    const beads = new THREE.InstancedMesh(beadGeo, beadMat, MAX_LIT)
    beads.count = 0
    scene.add(beads)

    // The selected tower gets a beam of light from its roof and a scan ring on the ground.
    const beamGeo = keep(new THREE.CylinderGeometry(0.05, 0.05, 1, 8, 1, true))
    beamGeo.translate(0, 0.5, 0)
    const beamMat = keep(new THREE.MeshBasicMaterial({
      color: new THREE.Color(CITY.lit).multiplyScalar(1.4), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    const beam = new THREE.Mesh(beamGeo, beamMat)
    beam.visible = false
    scene.add(beam)
    const ringGeo = keep(new THREE.RingGeometry(0.92, 1, 64))
    ringGeo.rotateX(-Math.PI / 2)
    const ringMat = keep(new THREE.MeshBasicMaterial({
      color: new THREE.Color(CITY.lit).multiplyScalar(1.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.position.y = 0.12
    ring.visible = false
    scene.add(ring)

    // --- focus ---------------------------------------------------------------------
    let lit: { a: number; b: number; type: string }[] = []
    let litGrow = 1
    let focusIdx = -1
    let focusAt = 0
    const clock = new THREE.Clock()
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
      const keepSet = focusIdx >= 0 ? near : hlIdx
      const dim = focusIdx >= 0 && tour ? 0.4 : 0.18
      towers.forEach((_, i) => {
        col.copy(base[i])
        if (i === focusIdx) col.setHex(CITY.lit).multiplyScalar(1.5)
        else if (keepSet && !keepSet.has(i)) col.multiplyScalar(dim)
        city.setColorAt(i, col)
      })
      city.instanceColor!.needsUpdate = true
      paintFaint(keepSet)
      faintMat.opacity = focusIdx >= 0 ? 0.18 : 0.3
      clearLit()
      lit.forEach((l) => {
        litGroup.add(new THREE.Mesh(tubeFor(towers[l.a], towers[l.b]), l.type === 'INHERITS' ? litMats.INHERITS : litMats.CALLS))
      })
      litGrow = reduceMotion ? 1 : 0
      beam.visible = ring.visible = focusIdx >= 0
      if (focusIdx >= 0) {
        const tw = towers[focusIdx]
        beam.position.set(tw.x, tw.h, tw.z)
        ring.position.x = tw.x
        ring.position.z = tw.z
      }
    }
    apiRef.current = { focus }

    // --- camera ------------------------------------------------------------------------
    let yaw = 0.75, pitch = 0.72
    // Distance that fits the whole city in the narrower of the two fields of view.
    const fitDist = () => {
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      const tanH = tanV * camera.aspect
      return (radius * 1.08) / Math.min(tanV * 1.3, tanH) + 6
    }
    let dist = 60, targetDist = dist, userZoomed = false
    const minD = Math.max(radius * 0.6, 8), maxD = radius * 8 + 60
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
    let hoverIdx = -1
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
      if (i !== hoverIdx) { hoverIdx = i; setHover(i >= 0 ? towers[i].node : null) }
      el.style.cursor = i >= 0 && onSelectRef.current ? 'pointer' : controls ? 'grab' : 'default'
    }
    const onLeave = () => { hoverIdx = -1; setHover(null) }
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
    if (controls) el.style.touchAction = 'none'
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    if (controls) el.addEventListener('wheel', onWheel, { passive: false })

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount
      renderer.setSize(w, h, false)
      composer.setPixelRatio(renderer.getPixelRatio())
      composer.setSize(w, h)
      camera.aspect = w / Math.max(h, 1)
      // Wide screens push the city aside for the copy; narrow ones keep it centred.
      // Portrait screens lift it into the top half, above the copy.
      const shift = camera.aspect > 1.2 ? offsetX : 0
      const lift = offsetX && camera.aspect < 1 ? 0.2 : 0
      if (shift || lift) camera.setViewOffset(w, h, -shift * w, lift * h, w, h)
      else camera.clearViewOffset()
      camera.updateProjectionMatrix()
      if (!userZoomed) targetDist = dist = Math.min(maxD, fitDist())
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()

    let visible = true
    const io = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    io.observe(mount)

    // Tour: hand the light from one well-connected tower to the next.
    const tourable = tour ? towers.map((_, i) => i).filter((i) => arcs.filter((l) => l.a === i).length >= 2) : []
    let tourAt = 0, tourStep = 0

    // --- loop ----------------------------------------------------------------------
    const bead = new THREE.Vector3()
    let frame = 0
    const render = () => {
      frame = requestAnimationFrame(render)
      if (!visible) return
      const dt = Math.min(clock.getDelta(), 0.05)
      const t = clock.elapsedTime
      towerMat.uniforms.uTime.value = reduceMotion ? 0 : t

      // Towers rise in a wave from the city centre on first paint.
      let growing = false
      towers.forEach((tw, i) => {
        if (rise[i] >= 1) return
        const delay = Math.hypot(tw.x, tw.z) / (radius + 1) * 0.9
        rise[i] = Math.min(1, Math.max(0, (t - delay) * 1.6))
        setTower(i, 1 - (1 - rise[i]) ** 3)
        growing = true
      })
      if (growing) city.instanceMatrix.needsUpdate = true

      if (tourable.length && !selectedRef.current && !reduceMotion && t > 1.6 && t - tourAt > 3.4) {
        tourAt = t
        focus(towers[tourable[(tourStep++ * 7) % tourable.length]].node.id, null)
      }

      // Lit arcs draw themselves outward, then carry a bead each.
      if (lit.length) {
        litGrow = Math.min(1, litGrow + dt * 1.8)
        // Tube indices run along the curve, so a partial draw range grows the arc from its caller.
        litGroup.children.forEach((c) => {
          const g = (c as THREE.Mesh).geometry
          g.setDrawRange(0, Math.ceil((g.index!.count / 6) * litGrow) * 6)
        })
        beads.count = litGrow >= 1 && !reduceMotion ? lit.length : 0
        lit.forEach((l, k) => {
          arcPoint(towers[l.a], towers[l.b], (t * 0.55 + k * 0.13) % 1, bead)
          beads.setMatrixAt(k, m.makeTranslation(bead.x, bead.y, bead.z))
        })
        beads.instanceMatrix.needsUpdate = true
      } else {
        beads.count = 0
      }

      if (focusIdx >= 0) {
        // The beam shoots up once, then the ring keeps scanning outwards.
        const since = t - focusAt
        beam.scale.set(1, reduceMotion ? 18 : Math.min(1, since * 2.5) * 18, 1)
        const cycle = reduceMotion ? 0.5 : (since % 2) / 2
        ring.scale.setScalar(0.6 + cycle * (2.5 + radius * 0.12))
        ringMat.opacity = 0.9 * (1 - cycle)
      }

      if (!dragging && !reduceMotion && performance.now() - idleSince > 1200) yaw += dt * 0.05
      dist += (targetDist - dist) * 0.1
      fog.near = dist * 0.9
      fog.far = dist * 2.4
      towerMat.uniforms.uNear.value = fog.near
      towerMat.uniforms.uFar.value = fog.far
      camera.position.set(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist)
      camera.lookAt(0, 1.5, 0)
      composer.render()

      const label = labelRef.current
      if (label) {
        if (hoverIdx >= 0) {
          const tw = towers[hoverIdx]
          bead.set(tw.x, tw.h, tw.z).project(camera)
          label.style.transform = `translate(${(bead.x * 0.5 + 0.5) * mount.clientWidth}px, ${(-bead.y * 0.5 + 0.5) * mount.clientHeight}px)`
          label.style.opacity = '1'
        } else label.style.opacity = '0'
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
      disposables.forEach((d) => d.dispose())
      clearLit()
      city.dispose(); slabs.dispose(); beads.dispose()
      bloom.dispose()
      composer.dispose()
      renderer.dispose()
      mount.removeChild(el)
      apiRef.current = null
    }
    // The city is rebuilt only when the graph itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  useEffect(() => {
    apiRef.current?.focus(selected, highlight)
  }, [selected, highlight, nodes, edges])

  return (
    <div className={`city ${className ?? ''}`}>
      <div ref={mountRef} className="city-canvas" />
      <div ref={labelRef} className="city-label" aria-hidden>
        {hover && (
          <>
            <strong>{hover.name ?? hover.id}</strong>
            <span>{hover.filepath}{hover.lines ? `, ${hover.lines} lines` : ''}</span>
          </>
        )}
      </div>
    </div>
  )
}
