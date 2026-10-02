import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export const INGEST_STAGES = [
  { key: 'CLONING', label: 'Clone', color: 0x9aa4c7 },
  { key: 'PARSING', label: 'Parse AST', color: 0xffc861 },
  { key: 'EMBEDDING', label: 'Embed', color: 0x7c9cff },
  { key: 'STORING', label: 'Store', color: 0xff8fa3 },
  { key: 'LINKING', label: 'Link graph', color: 0x3ee6c1 },
] as const

/**
 * The ingestion pipeline as a 3D track: five stations whose shapes echo what they do,
 * with file particles flowing along the path up to the stage currently running.
 * `stage` is the index of the running stage; STAGES.length means finished, -1 idle.
 */
export default function IngestScene({ stage, className }: { stage: number; className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef(stage)
  stageRef.current = stage

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    const root = new THREE.Group()
    // Sits in the upper part of the hero; the headline and form overlay the bottom.
    root.position.y = 2.4
    scene.add(root)
    const disposables: { dispose(): void }[] = []
    const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x)

    // Track: a gentle S-curve through five stations.
    const stationPos = [-8, -4, 0, 4, 8].map((x, i) => new THREE.Vector3(x, Math.sin(i * 1.3) * 0.9, Math.cos(i * 1.1) * 1.2))
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-11, stationPos[0].y, stationPos[0].z), ...stationPos, new THREE.Vector3(11, stationPos[4].y, stationPos[4].z),
    ])
    const tubeGeo = track(new THREE.TubeGeometry(curve, 200, 0.025, 6, false))
    const tubeMat = track(new THREE.MeshBasicMaterial({ color: 0x3a3d5c, transparent: true, opacity: 0.8 }))
    root.add(new THREE.Mesh(tubeGeo, tubeMat))

    // Where each station sits along the curve (0..1), for particle gating.
    const samples = curve.getSpacedPoints(400)
    const stationT = stationPos.map((p) => {
      let best = 0, bestD = Infinity
      samples.forEach((s, i) => { const d = s.distanceTo(p); if (d < bestD) { bestD = d; best = i } })
      return best / 400
    })

    // Stations: git blob, AST tree, vector cube, stacked stores, graph knot.
    const stationGeos = [
      new THREE.IcosahedronGeometry(0.9, 0),
      new THREE.ConeGeometry(0.85, 1.6, 6, 3),
      new THREE.BoxGeometry(1.3, 1.3, 1.3, 3, 3, 3),
      new THREE.CylinderGeometry(0.8, 0.8, 1.5, 16, 3),
      new THREE.TorusKnotGeometry(0.6, 0.16, 80, 10),
    ].map(track)

    const stations = stationGeos.map((geo, i) => {
      const group = new THREE.Group()
      group.position.copy(stationPos[i])
      const wireMat = track(new THREE.LineBasicMaterial({ color: INGEST_STAGES[i].color, transparent: true, opacity: 0.25 }))
      const wire = new THREE.LineSegments(track(new THREE.WireframeGeometry(geo)), wireMat)
      const coreMat = track(new THREE.MeshBasicMaterial({ color: INGEST_STAGES[i].color, transparent: true, opacity: 0.05 }))
      const core = new THREE.Mesh(geo, coreMat)
      const ringMat = track(new THREE.MeshBasicMaterial({ color: INGEST_STAGES[i].color, transparent: true, opacity: 0, side: THREE.DoubleSide }))
      const ring = new THREE.Mesh(track(new THREE.RingGeometry(1.25, 1.32, 64)), ringMat)
      group.add(wire, core, ring)
      root.add(group)
      return { group, wire, wireMat, coreMat, ring, ringMat }
    })

    // Particles.
    const COUNT = 180
    const parts = Array.from({ length: COUNT }, () => ({ t: Math.random(), speed: 0.05 + Math.random() * 0.06, jitter: new THREE.Vector3((Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 0.35) }))
    const pPos = new Float32Array(COUNT * 3)
    const pCol = new Float32Array(COUNT * 3)
    const pGeo = track(new THREE.BufferGeometry())
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
    pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3))
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 32, 32)
    const tex = track(new THREE.CanvasTexture(canvas))
    const pMat = track(new THREE.PointsMaterial({ size: 0.28, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
    root.add(new THREE.Points(pGeo, pMat))

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(h, 1)
      // Keep the whole track in frame on narrow screens.
      camera.position.set(0, 3.2, camera.aspect < 1 ? 34 : Math.max(17, 24 / camera.aspect))
      camera.lookAt(0, 0, 0)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()

    let visible = true
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
    io.observe(mount)

    const clock = new THREE.Clock()
    const col = new THREE.Color()
    const p = new THREE.Vector3()
    let frame = 0
    const render = () => {
      frame = requestAnimationFrame(render)
      if (!visible) return
      const dt = Math.min(clock.getDelta(), 0.05)
      const t = clock.elapsedTime
      const s = stageRef.current
      const done = s >= INGEST_STAGES.length
      const idle = s < 0

      stations.forEach((st, i) => {
        const active = i === s
        const reached = done || i < s
        st.wireMat.opacity += ((active ? 1 : reached ? 0.7 : idle ? 0.35 : 0.18) - st.wireMat.opacity) * 0.08
        st.coreMat.opacity += ((active ? 0.22 : reached ? 0.1 : 0.03) - st.coreMat.opacity) * 0.08
        st.ringMat.opacity = active ? 0.35 + Math.sin(t * 4) * 0.25 : st.ringMat.opacity * 0.92
        st.ring.scale.setScalar(active ? 1 + ((t * 0.8) % 1) * 0.5 : 1)
        st.ring.lookAt(camera.position)
        if (!reduceMotion) {
          st.wire.rotation.y += dt * (active ? 1.4 : 0.25)
          st.wire.rotation.x += dt * (active ? 0.6 : 0.1)
          st.group.position.y = stationPos[i].y + Math.sin(t * 1.2 + i) * 0.12
        }
      })

      // Particles run up to the active station (all the way once done).
      const limit = idle ? 0.04 : done ? 1 : stationT[Math.max(0, s)]
      parts.forEach((pt, i) => {
        if (!reduceMotion) pt.t += dt * pt.speed * (done ? 1.6 : 1)
        if (pt.t > limit) pt.t = done ? pt.t % 1 : Math.random() * 0.03
        curve.getPointAt(Math.min(pt.t, 1), p).add(pt.jitter)
        p.toArray(pPos, i * 3)
        // Particles take the colour of the last station they passed.
        let idx = 0
        stationT.forEach((st, k) => { if (pt.t >= st - 0.01) idx = k })
        col.setHex(pt.t < stationT[0] - 0.01 ? 0xc9d4ff : INGEST_STAGES[idx].color)
        col.toArray(pCol, i * 3)
      })
      pGeo.attributes.position.needsUpdate = true
      pGeo.attributes.color.needsUpdate = true

      if (!reduceMotion) root.rotation.y = Math.sin(t * 0.15) * 0.12
      renderer.render(scene, camera)
    }
    render()

    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      io.disconnect()
      disposables.forEach((d) => d.dispose())
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mountRef} className={className} aria-hidden />
}
