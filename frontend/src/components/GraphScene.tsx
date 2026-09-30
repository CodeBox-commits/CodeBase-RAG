import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/**
 * A living "code graph": clusters of symbols (modules), call edges between them,
 * and signal pulses travelling along calls. Pure three.js, no extra renderer libs.
 */

const PALETTE = [0x7c9cff, 0x9f7aea, 0x3ee6c1, 0xff8fa3, 0xffc861]

function makeGlowTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.8)')
  g.addColorStop(0.6, 'rgba(255,255,255,0.15)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// Deterministic PRNG so the graph looks the same on every visit.
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export default function GraphScene({ className }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const rand = mulberry32(7)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x07070d, 0.035)
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200)
    camera.position.set(0, 0, 26)

    const world = new THREE.Group()
    scene.add(world)
    const glow = makeGlowTexture()

    // --- nodes: clusters = modules, points = functions/classes -----------------
    const CLUSTERS = 7
    const PER_CLUSTER = 26
    const centers: THREE.Vector3[] = []
    for (let c = 0; c < CLUSTERS; c++) {
      const phi = Math.acos(1 - (2 * (c + 0.5)) / CLUSTERS)
      const theta = Math.PI * (1 + Math.sqrt(5)) * c
      centers.push(new THREE.Vector3().setFromSphericalCoords(8.5, phi, theta))
    }

    const nodes: { pos: THREE.Vector3; cluster: number; hub: boolean }[] = []
    centers.forEach((center, c) => {
      nodes.push({ pos: center.clone(), cluster: c, hub: true })
      for (let i = 0; i < PER_CLUSTER; i++) {
        const r = 1.2 + rand() * 2.8
        const p = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize().multiplyScalar(r)
        nodes.push({ pos: center.clone().add(p), cluster: c, hub: false })
      }
    })

    const positions = new Float32Array(nodes.length * 3)
    const colors = new Float32Array(nodes.length * 3)
    const sizes = new Float32Array(nodes.length)
    const col = new THREE.Color()
    nodes.forEach((n, i) => {
      n.pos.toArray(positions, i * 3)
      col.setHex(PALETTE[n.cluster % PALETTE.length])
      col.toArray(colors, i * 3)
      sizes[i] = n.hub ? 2.6 : 0.7 + rand() * 0.8
    })

    const nodeGeo = new THREE.BufferGeometry()
    nodeGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    nodeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    nodeGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1))

    const nodeMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: glow }, uTime: { value: 0 }, uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float size;
        varying vec3 vColor;
        uniform float uTime;
        uniform float uScale;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float twinkle = 0.85 + 0.15 * sin(uTime * 1.6 + position.x * 3.1 + position.y * 1.7);
          gl_PointSize = size * twinkle * uScale * (210.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        varying vec3 vColor;
        void main() {
          vec4 t = texture2D(uTex, gl_PointCoord);
          gl_FragColor = vec4(vColor, 1.0) * t;
        }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    world.add(new THREE.Points(nodeGeo, nodeMat))

    // --- edges: dense inside a cluster, sparse "cross-module calls" ------------
    const edges: [number, number][] = []
    const hubIndex = (c: number) => c * (PER_CLUSTER + 1)
    nodes.forEach((n, i) => {
      if (n.hub) return
      edges.push([hubIndex(n.cluster), i])
      if (rand() < 0.35) {
        const j = hubIndex(n.cluster) + 1 + Math.floor(rand() * PER_CLUSTER)
        if (j !== i) edges.push([i, j])
      }
      if (rand() < 0.07) {
        const other = Math.floor(rand() * CLUSTERS)
        if (other !== n.cluster) edges.push([i, hubIndex(other) + 1 + Math.floor(rand() * PER_CLUSTER)])
      }
    })
    for (let c = 0; c < CLUSTERS; c++) edges.push([hubIndex(c), hubIndex((c + 1) % CLUSTERS)])

    const linePos = new Float32Array(edges.length * 6)
    const lineCol = new Float32Array(edges.length * 6)
    edges.forEach(([a, b], k) => {
      nodes[a].pos.toArray(linePos, k * 6)
      nodes[b].pos.toArray(linePos, k * 6 + 3)
      col.setHex(PALETTE[nodes[a].cluster % PALETTE.length]).multiplyScalar(0.55)
      col.toArray(lineCol, k * 6)
      col.setHex(PALETTE[nodes[b].cluster % PALETTE.length]).multiplyScalar(0.55)
      col.toArray(lineCol, k * 6 + 3)
    })
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3))
    lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3))
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    world.add(new THREE.LineSegments(lineGeo, lineMat))

    // --- pulses: a query hopping along call edges ------------------------------
    const PULSES = 70
    const pulseState = Array.from({ length: PULSES }, () => ({
      edge: Math.floor(rand() * edges.length),
      t: rand(),
      speed: 0.25 + rand() * 0.55,
    }))
    const pulsePos = new Float32Array(PULSES * 3)
    const pulseGeo = new THREE.BufferGeometry()
    pulseGeo.setAttribute('position', new THREE.BufferAttribute(pulsePos, 3))
    const pulseMat = new THREE.PointsMaterial({
      size: 0.55,
      map: glow,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    world.add(new THREE.Points(pulseGeo, pulseMat))

    // --- starfield ---------------------------------------------------------------
    const STARS = 900
    const starPos = new Float32Array(STARS * 3)
    for (let i = 0; i < STARS; i++) {
      const v = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize().multiplyScalar(30 + rand() * 50)
      v.toArray(starPos, i * 3)
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ size: 0.12, color: 0x9aa4c7, transparent: true, opacity: 0.6, depthWrite: false }),
    )
    scene.add(stars)

    // --- interaction & loop -----------------------------------------------------
    const pointer = new THREE.Vector2()
    const onPointer = (e: PointerEvent) => {
      pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1)
    }
    window.addEventListener('pointermove', onPointer)

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(h, 1)
      camera.position.z = camera.aspect < 0.8 ? 34 : 26
      camera.updateProjectionMatrix()
      nodeMat.uniforms.uScale.value = renderer.getPixelRatio()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()

    let visible = true
    const io = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    io.observe(mount)

    const clock = new THREE.Clock()
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    let frame = 0

    const render = () => {
      frame = requestAnimationFrame(render)
      if (!visible) return
      const dt = Math.min(clock.getDelta(), 0.05)
      const t = clock.elapsedTime
      nodeMat.uniforms.uTime.value = t

      if (!reduceMotion) {
        world.rotation.y += dt * 0.06
        world.rotation.x += (pointer.y * 0.25 - world.rotation.x) * 0.03
        world.rotation.z += (-pointer.x * 0.12 - world.rotation.z) * 0.03
        stars.rotation.y -= dt * 0.01
        camera.position.x += (pointer.x * 2 - camera.position.x) * 0.02
        camera.lookAt(0, 0, 0)

        pulseState.forEach((p, i) => {
          p.t += dt * p.speed
          if (p.t >= 1) {
            // Continue along an edge that starts where this one ended: a walk through the call graph.
            const end = edges[p.edge][1]
            const next = edges.findIndex(([s], k) => s === end && k !== p.edge)
            p.edge = next >= 0 && rand() < 0.8 ? next : Math.floor(rand() * edges.length)
            p.t = 0
          }
          const [s, e] = edges[p.edge]
          a.copy(nodes[s].pos)
          b.copy(nodes[e].pos)
          a.lerp(b, p.t).toArray(pulsePos, i * 3)
        })
        pulseGeo.attributes.position.needsUpdate = true
      }
      renderer.render(scene, camera)
    }
    render()

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onPointer)
      ro.disconnect()
      io.disconnect()
      ;[nodeGeo, lineGeo, pulseGeo, starGeo].forEach((g) => g.dispose())
      ;[nodeMat, lineMat, pulseMat, stars.material as THREE.Material].forEach((m) => m.dispose())
      glow.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mountRef} className={className} aria-hidden />
}
