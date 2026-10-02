import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import type { GraphEdge, GraphNode } from '../api'

export const KIND_COLORS: Record<string, number> = {
  class: 0xffc861,
  method: 0x7c9cff,
  function: 0x3ee6c1,
}
export const EDGE_COLORS: Record<string, number> = {
  CALLS: 0x7c9cff,
  INHERITS: 0xff8fa3,
  HAS_METHOD: 0x6b6f8a,
}

interface Props {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selected?: string | null
  highlight?: Set<string> | null
  onSelect?: (id: string | null) => void
  className?: string
  autoRotate?: boolean
}

interface SimNode { id: string; pos: THREE.Vector3; vel: THREE.Vector3; node: GraphNode; degree: number }

function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.3, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.65, 'rgba(255,255,255,0.12)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

/**
 * Self-contained 3D force-directed graph: a small n-body layout (repulsion + springs +
 * centering) that settles over the first few seconds, rendered with additive glow points.
 */
export default function ForceGraph3D({
  nodes, edges, selected = null, highlight = null, onSelect, className, autoRotate = true,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<{ setFocus: (sel: string | null, hl: Set<string> | null) => void } | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const [hover, setHover] = useState<GraphNode | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || nodes.length === 0) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000)
    const world = new THREE.Group()
    scene.add(world)

    // --- simulation state ------------------------------------------------------
    const degree = new Map<string, number>()
    edges.forEach((e) => {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    })
    const spread = Math.cbrt(nodes.length) * 7
    const sim: SimNode[] = nodes.map((n, i) => {
      // Fibonacci sphere start avoids overlapping initial positions.
      const phi = Math.acos(1 - (2 * (i + 0.5)) / nodes.length)
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      return {
        id: n.id,
        node: n,
        degree: n.degree ?? degree.get(n.id) ?? 0,
        pos: new THREE.Vector3().setFromSphericalCoords(spread * (0.4 + Math.random() * 0.6), phi, theta),
        vel: new THREE.Vector3(),
      }
    })
    const indexOf = new Map(sim.map((s, i) => [s.id, i]))
    const links = edges
      .map((e) => ({ a: indexOf.get(e.source), b: indexOf.get(e.target), type: e.type }))
      .filter((l): l is { a: number; b: number; type: string } => l.a !== undefined && l.b !== undefined && l.a !== l.b)

    // --- nodes -------------------------------------------------------------------
    const glow = glowTexture()
    const positions = new Float32Array(sim.length * 3)
    const colors = new Float32Array(sim.length * 3)
    const baseColors = new Float32Array(sim.length * 3)
    const sizes = new Float32Array(sim.length)
    const col = new THREE.Color()
    sim.forEach((s, i) => {
      col.setHex(KIND_COLORS[s.node.kind] ?? 0xc9d4ff)
      col.toArray(baseColors, i * 3)
      col.toArray(colors, i * 3)
      sizes[i] = (s.node.anchor ? 6 : 3) + Math.min(s.degree, 20) * 0.35
    })
    const nodeGeo = new THREE.BufferGeometry()
    nodeGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    nodeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    nodeGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
    const nodeMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: glow }, uScale: { value: renderer.getPixelRatio() }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float size; varying vec3 vColor; uniform float uScale; uniform float uTime;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale * (240.0 / -mv.z) * (0.92 + 0.08 * sin(uTime * 2.0 + position.x));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0) * texture2D(uTex, gl_PointCoord); }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(nodeGeo, nodeMat)
    world.add(points)

    // --- edges -------------------------------------------------------------------
    const linePos = new Float32Array(links.length * 6)
    const lineCol = new Float32Array(links.length * 6)
    const lineBase = new Float32Array(links.length * 6)
    links.forEach((l, k) => {
      col.setHex(EDGE_COLORS[l.type] ?? 0x8890b0)
      col.toArray(lineBase, k * 6)
      col.toArray(lineBase, k * 6 + 3)
    })
    lineCol.set(lineBase)
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3))
    lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3))
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    world.add(new THREE.LineSegments(lineGeo, lineMat))

    // Particles travelling along edges in their direction (caller → callee).
    const FLOW = Math.min(links.length, 160)
    const flow = Array.from({ length: FLOW }, (_, i) => ({ link: i % Math.max(links.length, 1), t: Math.random() }))
    const flowPos = new Float32Array(FLOW * 3)
    const flowGeo = new THREE.BufferGeometry()
    flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3))
    const flowMat = new THREE.PointsMaterial({
      size: 1.1, map: glow, color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    world.add(new THREE.Points(flowGeo, flowMat))

    // --- focus (selection + highlight) --------------------------------------------
    let focusSet: Set<string> | null = null
    const applyFocus = (sel: string | null, hl: Set<string> | null) => {
      let set: Set<string> | null = hl && hl.size ? new Set(hl) : null
      if (sel) {
        set = set ?? new Set()
        set.add(sel)
        links.forEach((l) => {
          if (sim[l.a].id === sel) set!.add(sim[l.b].id)
          if (sim[l.b].id === sel) set!.add(sim[l.a].id)
        })
      }
      focusSet = set
      sim.forEach((s, i) => {
        const dim = set && !set.has(s.id) ? 0.12 : 1
        const boost = sel === s.id ? 1.6 : 1
        for (let c = 0; c < 3; c++) colors[i * 3 + c] = Math.min(baseColors[i * 3 + c] * dim * boost, 1.6)
      })
      nodeGeo.attributes.color.needsUpdate = true
      links.forEach((l, k) => {
        const on = !set || (set.has(sim[l.a].id) && set.has(sim[l.b].id))
        const f = on ? (set ? 1.6 : 1) : 0.06
        for (let c = 0; c < 6; c++) lineCol[k * 6 + c] = lineBase[k * 6 + c] * f
      })
      lineGeo.attributes.color.needsUpdate = true
    }
    apiRef.current = { setFocus: applyFocus }

    // --- camera controls: drag to orbit, wheel to zoom -----------------------------
    let yaw = 0.6, pitch = 0.25, dist = spread * 3.1, targetDist = dist
    let dragging = false, moved = false, lastX = 0, lastY = 0, idleSince = performance.now()
    let userZoomed = false
    const el = renderer.domElement
    el.style.touchAction = 'none'
    el.style.cursor = 'grab'
    const onDown = (e: PointerEvent) => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing' }
    const onUp = (e: PointerEvent) => {
      dragging = false; el.style.cursor = 'grab'; idleSince = performance.now()
      if (!moved) onSelectRef.current?.(pick(e)?.id ?? null)
    }
    const pointer = new THREE.Vector2()
    const raycaster = new THREE.Raycaster()
    const pick = (e: PointerEvent | MouseEvent) => {
      const rect = el.getBoundingClientRect()
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.params.Points = { threshold: Math.max(1.2, dist / 60) }
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObject(points)[0]
      return hit?.index !== undefined ? sim[hit.index] : null
    }
    let hoverId: string | null = null
    const onMove = (e: PointerEvent) => {
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
        yaw -= dx * 0.006
        pitch = Math.max(-1.3, Math.min(1.3, pitch + dy * 0.006))
        lastX = e.clientX; lastY = e.clientY
        return
      }
      const hit = pick(e)
      if ((hit?.id ?? null) !== hoverId) {
        hoverId = hit?.id ?? null
        setHover(hit?.node ?? null)
      }
      el.style.cursor = hit ? 'pointer' : 'grab'
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      userZoomed = true
      targetDist = Math.max(spread * 0.6, Math.min(spread * 8, targetDist * (1 + Math.sign(e.deltaY) * 0.12)))
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('wheel', onWheel, { passive: false })
    const onLeave = () => { hoverId = null; setHover(null) }
    el.addEventListener('pointerleave', onLeave)

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(h, 1)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()

    let visible = true
    const io = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    io.observe(mount)

    // --- loop ------------------------------------------------------------------
    const tmp = new THREE.Vector3()
    const centroid = new THREE.Vector3()
    let alpha = 1
    let frame = 0
    const clock = new THREE.Clock()
    const projected = new THREE.Vector3()

    const step = () => {
      const n = sim.length
      const k = spread * 0.55
      for (let i = 0; i < n; i++) {
        const a = sim[i]
        for (let j = i + 1; j < n; j++) {
          const b = sim[j]
          tmp.subVectors(a.pos, b.pos)
          const d2 = Math.max(tmp.lengthSq(), 0.5)
          const f = (k * k * 0.9) / d2
          tmp.multiplyScalar(f / Math.sqrt(d2))
          a.vel.addScaledVector(tmp, alpha * 0.02)
          b.vel.addScaledVector(tmp, -alpha * 0.02)
        }
      }
      links.forEach(({ a, b }) => {
        tmp.subVectors(sim[b].pos, sim[a].pos)
        const d = Math.max(tmp.length(), 0.01)
        const f = (d - k * 0.5) * 0.04 * alpha
        tmp.multiplyScalar(f / d)
        sim[a].vel.add(tmp)
        sim[b].vel.sub(tmp)
      })
      centroid.set(0, 0, 0)
      sim.forEach((s) => centroid.add(s.pos))
      centroid.divideScalar(n)
      sim.forEach((s) => {
        s.vel.addScaledVector(s.pos, -0.014 * alpha)
        s.vel.multiplyScalar(0.82)
        s.pos.add(s.vel).sub(tmp.copy(centroid).multiplyScalar(0.05))
      })
      alpha = Math.max(alpha * 0.992, 0.02)
    }

    // Pre-settle so the first frame isn't a ball of noise; larger graphs get fewer.
    const warm = reduceMotion ? 300 : Math.max(20, Math.floor(6000 / Math.max(nodes.length, 1)))
    for (let i = 0; i < warm; i++) step()

    // Frame the graph by its real extent (small graphs would otherwise sit tiny in the middle).
    const fit = () => {
      let r = 0
      sim.forEach((s) => { r = Math.max(r, tmp.copy(s.pos).sub(centroid).length()) })
      return Math.max(r * 2.4, 8)
    }
    centroid.set(0, 0, 0)
    sim.forEach((s) => centroid.add(s.pos))
    centroid.divideScalar(sim.length)
    dist = targetDist = fit()

    const render = () => {
      frame = requestAnimationFrame(render)
      if (!visible) return
      const dt = Math.min(clock.getDelta(), 0.05)
      nodeMat.uniforms.uTime.value = clock.elapsedTime
      if (alpha > 0.021) {
        step()
        if (!userZoomed) targetDist = fit()
      }

      sim.forEach((s, i) => s.pos.toArray(positions, i * 3))
      nodeGeo.attributes.position.needsUpdate = true
      links.forEach((l, k) => {
        sim[l.a].pos.toArray(linePos, k * 6)
        sim[l.b].pos.toArray(linePos, k * 6 + 3)
      })
      lineGeo.attributes.position.needsUpdate = true

      if (links.length) {
        flow.forEach((f, i) => {
          f.t += dt * 0.5
          if (f.t > 1) { f.t = 0; f.link = Math.floor(Math.random() * links.length) }
          const l = links[f.link]
          const lit = !focusSet || (focusSet.has(sim[l.a].id) && focusSet.has(sim[l.b].id))
          if (!lit) { flowPos[i * 3] = 1e6; return }
          tmp.lerpVectors(sim[l.a].pos, sim[l.b].pos, f.t).toArray(flowPos, i * 3)
        })
        flowGeo.attributes.position.needsUpdate = true
      }

      if (autoRotate && !dragging && !reduceMotion && performance.now() - idleSince > 1500) yaw += dt * 0.08
      dist += (targetDist - dist) * 0.1
      camera.position.set(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist)
      camera.position.add(centroid)
      camera.lookAt(centroid)
      renderer.render(scene, camera)

      // Hover label follows its node on screen.
      const label = labelRef.current
      if (label) {
        const target = hoverId ? sim[indexOf.get(hoverId)!] : null
        if (target) {
          projected.copy(target.pos).project(camera)
          label.style.transform = `translate(${(projected.x * 0.5 + 0.5) * mount.clientWidth}px, ${(-projected.y * 0.5 + 0.5) * mount.clientHeight}px)`
          label.style.opacity = '1'
        } else {
          label.style.opacity = '0'
        }
      }
    }
    render()

    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      io.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerleave', onLeave)
      ;[nodeGeo, lineGeo, flowGeo].forEach((g) => g.dispose())
      ;[nodeMat, lineMat, flowMat].forEach((m) => m.dispose())
      glow.dispose()
      renderer.dispose()
      mount.removeChild(el)
      apiRef.current = null
    }
    // The scene is rebuilt only when the graph itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  useEffect(() => {
    apiRef.current?.setFocus(selected, highlight)
  }, [selected, highlight, nodes, edges])

  return (
    <div className={`fg3d ${className ?? ''}`}>
      <div ref={mountRef} className="fg3d-canvas" />
      <div ref={labelRef} className="fg3d-label" aria-hidden>
        {hover && (
          <>
            <strong>{hover.name ?? hover.id}</strong>
            <span>{hover.kind}{hover.filepath ? ` · ${hover.filepath}` : ''}</span>
          </>
        )}
      </div>
    </div>
  )
}
