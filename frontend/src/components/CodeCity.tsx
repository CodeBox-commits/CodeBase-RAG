import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { cn } from '@/lib/utils'
import { useModelPalette, type ModelPalette } from '../palette'

/**
 * A repository as an architectural massing model, seen in axonometric.
 *
 * The base board is the repository, each raised plot a file, each block a function (white
 * card), method (grey board) or class (basswood), as tall as its code is long. Calls are
 * threads strung between rooftops. Selecting a block pins it, draws its calls taut in the
 * thread colour and lets the rest of the model fall back to plain board.
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
  /** Passes the pin from one well-connected block to the next while nothing is selected. */
  tour?: boolean
  /** Shifts the model sideways in frame (fraction of the width), to leave room for copy. */
  offsetX?: number
  /** Multiplies the framed size: >1 shows more margin around the model. */
  framing?: number
  className?: string
}

interface Tower { node: CityNode; x: number; z: number; h: number; w: number }

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const PLINTH = 0.5
const PLOT = 0.07

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

  // Shelf-pack the file plots into a roughly square board; a new directory leaves a wider street.
  const area = blocks.reduce((s, b) => s + (b.size + 1) ** 2, 0)
  const maxW = Math.max(Math.sqrt(area) * 1.15, 6)
  const towers: Tower[] = []
  const plots: { x: number; z: number; size: number; file: string }[] = []
  let x = 0, z = 0, rowH = 0, prevDir: string | null = null
  blocks.forEach((b) => {
    const dir = dirname(b.file)
    if (prevDir !== null && dir !== prevDir) x += 1.2
    if (x + b.size > maxW && x > 0) { x = 0; z += rowH + 1; rowH = 0 }
    plots.push({ x: x + b.size / 2, z: z + b.size / 2, size: b.size, file: b.file })
    b.items.forEach((node, i) => {
      const lines = Math.max(node.lines ?? 6, 1)
      towers.push({
        node,
        x: x + 0.75 + (i % b.n),
        z: z + 0.75 + Math.floor(i / b.n),
        h: Math.min(0.3 + Math.sqrt(lines) * 0.4, 9),
        w: node.kind === 'class' ? 0.8 : node.kind === 'method' ? 0.56 : 0.64,
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
  return { towers, plots, width, depth, radius: Math.hypot(width, depth) / 2 }
}

/** A point on the thread from rooftop a to rooftop b; longer threads hang higher. */
function arcPoint(a: Tower, b: Tower, t: number, out: THREE.Vector3) {
  const span = Math.hypot(b.x - a.x, b.z - a.z)
  const y0 = PLOT + a.h, y1 = PLOT + b.h
  const top = Math.max(y0, y1) + 0.8 + span * 0.3
  const u = 1 - t
  out.set(a.x + (b.x - a.x) * t, u * u * y0 + 2 * u * t * top + t * t * y1, a.z + (b.z - a.z) * t)
  return out
}

const ARC_SEGMENTS = 16
const MAX_LIT = 80

/** A soft round shadow for under the base board, so the model sits on the page. */
function contactShadowTexture(color: number) {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const c = new THREE.Color(color)
  const rgb = `${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}`
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, `rgba(${rgb}, 0.55)`)
  g.addColorStop(0.55, `rgba(${rgb}, 0.22)`)
  g.addColorStop(1, `rgba(${rgb}, 0)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export default function CodeCity({
  nodes, edges, selected = null, highlight = null, onSelect, controls = true, tour = false, offsetX = 0, framing = 1, className,
}: Props) {
  const palette = useModelPalette()
  const mountRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<{ focus: (sel: string | null, hl: Set<string> | null) => void; reframe: () => void } | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const [hover, setHover] = useState<CityNode | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const offsetRef = useRef(offsetX)
  offsetRef.current = offsetX
  // The camera survives a theme switch: the scene is rebuilt, the view isn't reset.
  const viewRef = useRef<{ yaw: number; pitch: number; zoom: number | null }>({ yaw: 0.78, pitch: 0.62, zoom: null })

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || nodes.length === 0) return
    const pal: ModelPalette = palette
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500)
    const disposables: { dispose(): void }[] = []
    const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x)

    const { towers, plots, width, depth, radius } = layoutCity(nodes)
    const indexOf = new Map(towers.map((t, i) => [t.node.id, i]))
    const links = edges
      .map((e) => ({ a: indexOf.get(e.source), b: indexOf.get(e.target), type: e.type }))
      .filter((l): l is { a: number; b: number; type: string } => l.a !== undefined && l.b !== undefined && l.a !== l.b)
    // Membership is implied by the plots; only calls and inheritance are strung as threads.
    const arcs = links.filter((l) => l.type !== 'HAS_METHOD')

    // --- light: one sun casting soft shadows, and sky light for the shaded faces -------
    scene.add(new THREE.HemisphereLight(pal.dark ? 0xdfe7ff : 0xffffff, pal.dark ? 0x3a5aa8 : 0xb9c1b8, pal.dark ? 2.1 : 1.55))
    const sun = new THREE.DirectionalLight(pal.dark ? 0xe6edff : 0xfffbf2, pal.dark ? 2.3 : 2.1)
    sun.position.set(-radius * 0.9, radius * 1.6 + 10, radius * 0.6)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const sc = sun.shadow.camera
    sc.left = sc.bottom = -radius * 1.4
    sc.right = sc.top = radius * 1.4
    sc.near = 0.5
    sc.far = radius * 6 + 60
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.02
    sun.shadow.radius = 4
    scene.add(sun)

    // --- base board, its contact shadow on the page, and one raised plot per file ------
    const boardW = width + 2, boardD = depth + 2
    const board = new THREE.Mesh(
      keep(new THREE.BoxGeometry(boardW, PLINTH, boardD)),
      keep(new THREE.MeshStandardMaterial({ color: pal.ground, roughness: 0.95 })),
    )
    board.position.y = -PLINTH / 2
    board.receiveShadow = true
    scene.add(board)

    const shadowTex = keep(contactShadowTexture(pal.shadow))
    const contact = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(boardW * 1.5, boardD * 1.5)),
      keep(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })),
    )
    contact.rotation.x = -Math.PI / 2
    contact.position.y = -PLINTH - 0.01
    scene.add(contact)

    const plotMat = keep(new THREE.MeshStandardMaterial({ color: pal.plot, roughness: 0.9 }))
    const plotMesh = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(1, PLOT, 1)), plotMat, plots.length)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    plots.forEach((p, i) => plotMesh.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, PLOT / 2, p.z), q, new THREE.Vector3(p.size, 1, p.size))))
    plotMesh.receiveShadow = true
    scene.add(plotMesh)

    // --- blocks --------------------------------------------------------------------------
    const towerGeo = keep(new THREE.BoxGeometry(1, 1, 1))
    towerGeo.translate(0, 0.5, 0)
    const towerMat = keep(new THREE.MeshStandardMaterial({ roughness: pal.dark ? 0.7 : 0.88, metalness: 0 }))
    const city = new THREE.InstancedMesh(towerGeo, towerMat, towers.length)
    city.castShadow = true
    city.receiveShadow = true
    const base = towers.map((t) => new THREE.Color(pal.kinds[t.node.kind] ?? pal.kinds.method))
    const rise = new Float32Array(towers.length)
    const setTower = (i: number, grow: number) => {
      const t = towers[i]
      m.compose(new THREE.Vector3(t.x, PLOT, t.z), q, new THREE.Vector3(t.w, Math.max(t.h * grow, 0.001), t.w))
      city.setMatrixAt(i, m)
    }
    towers.forEach((_, i) => { rise[i] = reduceMotion ? 1 : 0; setTower(i, rise[i]); city.setColorAt(i, base[i]) })
    scene.add(city)

    // Cut edges: a hairline in light, the white linework of a blueprint in dark.
    const edgePos: number[] = []
    const unit = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]
    const edgeRanges: [number, number][] = []
    towers.forEach((t) => {
      const start = edgePos.length / 3
      const hw = t.w
      const pts = unit.map(([ux, uz]) => [t.x + ux * hw, t.z + uz * hw])
      pts.forEach(([ax, az], k) => {
        const [bx, bz] = pts[(k + 1) % 4]
        edgePos.push(ax, PLOT + t.h, az, bx, PLOT + t.h, bz) // roof
        edgePos.push(ax, PLOT, az, ax, PLOT + t.h, az) // vertical corner
      })
      edgeRanges.push([start, edgePos.length / 3 - start])
    })
    const edgeGeo = keep(new THREE.BufferGeometry())
    const edgeArr = new Float32Array(edgePos)
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgeArr, 3))
    const edgeMat = keep(new THREE.LineBasicMaterial({
      color: pal.dark ? 0xffffff : pal.graphite, transparent: true, opacity: pal.dark ? 0.42 : 0.14,
    }))
    const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat)
    // Edges grow with their block on first paint.
    const edgeFull = edgeArr.slice()
    const growEdges = (i: number, grow: number) => {
      const [start, count] = edgeRanges[i]
      for (let k = start; k < start + count; k++) {
        const y = edgeFull[k * 3 + 1]
        edgeArr[k * 3 + 1] = PLOT + (y - PLOT) * grow
      }
    }
    if (!reduceMotion) towers.forEach((_, i) => growEdges(i, 0))
    scene.add(edgeLines)

    // --- threads: a faint layer for every call, taut tubes for the selected block --------
    const faintPos = new Float32Array(arcs.length * ARC_SEGMENTS * 6)
    const faintCol = new Float32Array(arcs.length * ARC_SEGMENTS * 6)
    const faintGeo = keep(new THREE.BufferGeometry())
    faintGeo.setAttribute('position', new THREE.BufferAttribute(faintPos, 3))
    faintGeo.setAttribute('color', new THREE.BufferAttribute(faintCol, 3))
    // Fewer, clearer threads in big repositories: the faint layer thins out as calls multiply.
    const faintBase = THREE.MathUtils.clamp(0.24 * Math.sqrt(120 / Math.max(arcs.length, 1)), 0.05, 0.24)
    const faintMat = keep(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: faintBase, depthWrite: false }))
    const faint = new THREE.LineSegments(faintGeo, faintMat)
    scene.add(faint)

    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3()
    const col = new THREE.Color()
    const groundCol = new THREE.Color(pal.ground)
    const paintFaint = (only: Set<number> | null) => {
      arcs.forEach((l, k) => {
        col.setHex(pal.edges[l.type] ?? pal.thread)
        if (only && !(only.has(l.a) && only.has(l.b))) col.lerp(groundCol, 0.85)
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

    const litGroup = new THREE.Group()
    scene.add(litGroup)
    const litMats = {
      CALLS: keep(new THREE.MeshBasicMaterial({ color: pal.thread })),
      INHERITS: keep(new THREE.MeshBasicMaterial({ color: pal.edges.INHERITS })),
    }
    const clearLit = () => {
      litGroup.children.forEach((c) => (c as THREE.Mesh).geometry.dispose())
      litGroup.clear()
    }
    const threadRadius = Math.max(0.035, radius * 0.0022)
    const tubeFor = (a: Tower, b: Tower) => {
      const pts = Array.from({ length: 33 }, (_, s) => arcPoint(a, b, s / 32, new THREE.Vector3()))
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, threadRadius, 6, false)
    }

    // Beads run caller → callee along each taut thread.
    const beadMat = keep(new THREE.MeshBasicMaterial({ color: pal.thread }))
    const beads = new THREE.InstancedMesh(keep(new THREE.SphereGeometry(threadRadius * 2.6, 12, 10)), beadMat, MAX_LIT)
    beads.count = 0
    scene.add(beads)

    // The selected block gets a model-maker's pin: a needle and a round head.
    const pin = new THREE.Group()
    const needleMat = keep(new THREE.MeshStandardMaterial({ color: pal.dark ? 0xe8eeff : 0x8b929c, metalness: 0.6, roughness: 0.35 }))
    const needle = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.025, 0.025, 1.8, 8)), needleMat)
    needle.position.y = 0.9
    const head = new THREE.Mesh(
      keep(new THREE.SphereGeometry(0.26, 24, 16)),
      keep(new THREE.MeshStandardMaterial({ color: pal.thread, roughness: 0.35 })),
    )
    head.position.y = 1.9
    head.castShadow = true
    needle.castShadow = true
    pin.add(needle, head)
    pin.visible = false
    scene.add(pin)

    // --- focus -----------------------------------------------------------------------------
    let lit: { a: number; b: number; type: string }[] = []
    let litGrow = 1
    let focusIdx = -1
    let focusAt = 0
    const clock = new THREE.Clock()
    const threadCol = new THREE.Color(pal.thread)
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
      towers.forEach((_, i) => {
        col.copy(base[i])
        if (i === focusIdx) col.copy(base[i]).lerp(threadCol, 0.55)
        else if (hlIdx?.has(i) && focusIdx < 0) col.copy(base[i]).lerp(threadCol, 0.35)
        else if (keepSet && !keepSet.has(i)) col.lerp(groundCol, 0.72)
        city.setColorAt(i, col)
      })
      city.instanceColor!.needsUpdate = true
      paintFaint(keepSet)
      faintMat.opacity = focusIdx >= 0 ? faintBase * 0.5 : faintBase
      clearLit()
      lit.forEach((l) => {
        litGroup.add(new THREE.Mesh(tubeFor(towers[l.a], towers[l.b]), l.type === 'INHERITS' ? litMats.INHERITS : litMats.CALLS))
      })
      litGrow = reduceMotion ? 1 : 0
      pin.visible = focusIdx >= 0
      if (focusIdx >= 0) {
        const tw = towers[focusIdx]
        pin.position.set(tw.x, PLOT + tw.h, tw.z)
      }
    }

    // --- camera: axonometric orbit ------------------------------------------------------------
    const view = viewRef.current
    let { yaw, pitch } = view
    let zoom = view.zoom ?? 1, targetZoom = zoom
    const minZoom = 0.6, maxZoom = 6
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
        pitch = Math.max(0.2, Math.min(1.45, pitch + dy * 0.005))
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
      targetZoom = Math.max(minZoom, Math.min(maxZoom, targetZoom * (1 - Math.sign(e.deltaY) * 0.1)))
    }
    if (controls) el.style.touchAction = 'none'
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    if (controls) el.addEventListener('wheel', onWheel, { passive: false })

    let frustum = 10
    const boardDiagonal = Math.hypot(boardW, boardD)
    const tallest = Math.max(...towers.map((t) => t.h), 1)
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount
      renderer.setSize(w, h, false)
      const aspect = w / Math.max(h, 1)
      // Fit the whole board in both dimensions: its diagonal across, and its depth plus
      // the tallest blocks (foreshortened by the pitch) down.
      const across = boardDiagonal * 1.04
      const down = boardDiagonal * Math.sin(view.pitch) * 0.98 + tallest * Math.cos(view.pitch) + 2
      frustum = Math.max(down, across / aspect) * framing
      camera.left = (-frustum * aspect) / 2
      camera.right = (frustum * aspect) / 2
      camera.top = frustum / 2
      camera.bottom = -frustum / 2
      const shift = aspect > 1.2 ? offsetRef.current : 0
      if (shift) camera.setViewOffset(w, h, -shift * w, 0, w, h)
      else camera.clearViewOffset()
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()
    apiRef.current = { focus, reframe: resize }

    let visible = true
    const io = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    io.observe(mount)

    const tourable = tour ? towers.map((_, i) => i).filter((i) => arcs.filter((l) => l.a === i).length >= 2) : []
    let tourAt = 0, tourStep = 0

    // --- loop --------------------------------------------------------------------------------
    const bead = new THREE.Vector3()
    const target = new THREE.Vector3(0, 1.2, 0)
    let frame = 0
    const render = () => {
      frame = requestAnimationFrame(render)
      if (!visible) return
      const dt = Math.min(clock.getDelta(), 0.05)
      const t = clock.elapsedTime

      // The one orchestrated moment: blocks rise from the centre of the board outwards.
      let growing = false
      towers.forEach((tw, i) => {
        if (rise[i] >= 1) return
        const delay = (Math.hypot(tw.x, tw.z) / (radius + 1)) * 0.8
        rise[i] = Math.min(1, Math.max(0, (t - delay) * 1.5))
        const g = 1 - (1 - rise[i]) ** 3
        setTower(i, g)
        growEdges(i, g)
        growing = true
      })
      if (growing) {
        city.instanceMatrix.needsUpdate = true
        edgeGeo.attributes.position.needsUpdate = true
        city.computeBoundingSphere()
      }

      if (tourable.length && !selectedRef.current && !reduceMotion && t > 1.8 && t - tourAt > 3.6) {
        tourAt = t
        focus(towers[tourable[(tourStep++ * 7) % tourable.length]].node.id, null)
      }

      if (lit.length) {
        litGrow = Math.min(1, litGrow + dt * 2)
        litGroup.children.forEach((c) => {
          const g = (c as THREE.Mesh).geometry
          g.setDrawRange(0, Math.ceil((g.index!.count / 6) * litGrow) * 6)
        })
        beads.count = litGrow >= 1 && !reduceMotion ? lit.length : 0
        lit.forEach((l, k) => {
          arcPoint(towers[l.a], towers[l.b], (t * 0.45 + k * 0.13) % 1, bead)
          beads.setMatrixAt(k, m.makeTranslation(bead.x, bead.y, bead.z))
        })
        beads.instanceMatrix.needsUpdate = true
      } else {
        beads.count = 0
      }

      if (pin.visible) {
        // The pin drops in once, then rests.
        const since = t - focusAt
        const drop = reduceMotion ? 0 : Math.max(0, 1 - since * 3.5) ** 2 * 3
        pin.position.y = PLOT + towers[focusIdx].h + drop
      }

      if (!dragging && !reduceMotion && performance.now() - idleSince > 1500) yaw += dt * 0.04
      zoom += (targetZoom - zoom) * 0.12
      camera.zoom = zoom
      camera.updateProjectionMatrix()
      const d = radius * 4 + 40
      camera.position.set(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d)
      camera.lookAt(target)
      view.yaw = yaw; view.pitch = pitch; view.zoom = zoom
      renderer.render(scene, camera)

      const label = labelRef.current
      if (label) {
        if (hoverIdx >= 0) {
          const tw = towers[hoverIdx]
          bead.set(tw.x, PLOT + tw.h, tw.z).project(camera)
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
      disposables.forEach((x) => x.dispose())
      clearLit()
      city.dispose(); plotMesh.dispose(); beads.dispose()
      sun.shadow.map?.dispose()
      renderer.dispose()
      mount.removeChild(el)
      apiRef.current = null
    }
    // The model is rebuilt only when the graph or the theme changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, palette])

  useEffect(() => {
    apiRef.current?.focus(selected, highlight)
  }, [selected, highlight, nodes, edges, palette])

  // Reframe (without rebuilding) when the requested offset changes.
  useEffect(() => {
    apiRef.current?.reframe()
  }, [offsetX])

  return (
    <div className={cn('relative overflow-hidden', className)}>
      <div ref={mountRef} className="absolute inset-0 [&>canvas]:block [&>canvas]:size-full" />
      <div
        ref={labelRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 z-10 opacity-0 transition-opacity duration-150"
      >
        {hover && (
          <div className="-translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-md border bg-popover px-2.5 py-1.5 shadow-sm">
            <div className="font-mono text-[0.78rem] font-medium text-foreground">{hover.name ?? hover.id}</div>
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
