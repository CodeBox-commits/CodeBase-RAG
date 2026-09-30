import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/** Three stores orbiting one query core: Neo4j (graph), Qdrant (vectors), RediSearch (BM25). */
export const ORBITS = [
  { name: 'Neo4j', color: 0x3ee6c1, radius: 3.2, tilt: 0.35, speed: 0.45 },
  { name: 'Qdrant', color: 0x7c9cff, radius: 4.4, tilt: -0.55, speed: 0.3 },
  { name: 'RediSearch', color: 0xff8fa3, radius: 5.6, tilt: 1.1, speed: 0.22 },
]

export default function OrbitScene({ className }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(0, 2.5, 15)
    camera.lookAt(0, 0, 0)

    const root = new THREE.Group()
    scene.add(root)

    // Core: wireframe icosahedron inside a soft shell.
    const coreGeo = new THREE.IcosahedronGeometry(1.35, 1)
    const coreWire = new THREE.LineSegments(
      new THREE.WireframeGeometry(coreGeo),
      new THREE.LineBasicMaterial({ color: 0xc9d4ff, transparent: true, opacity: 0.75 }),
    )
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.7, 3),
      new THREE.MeshBasicMaterial({ color: 0x7c9cff, transparent: true, opacity: 0.08 }),
    )
    root.add(coreWire, shell)

    const disposables: { dispose(): void }[] = [coreGeo, coreWire.geometry, coreWire.material as THREE.Material, shell.geometry, shell.material as THREE.Material]

    const satellites: { mesh: THREE.Group; orbit: (typeof ORBITS)[number]; phase: number }[] = []
    ORBITS.forEach((orbit, i) => {
      const plane = new THREE.Group()
      plane.rotation.x = Math.PI / 2 + orbit.tilt * 0.4
      plane.rotation.y = orbit.tilt
      root.add(plane)

      const ringGeo = new THREE.TorusGeometry(orbit.radius, 0.012, 8, 160)
      const ringMat = new THREE.MeshBasicMaterial({ color: orbit.color, transparent: true, opacity: 0.45 })
      plane.add(new THREE.Mesh(ringGeo, ringMat))

      const sat = new THREE.Group()
      const satGeo = new THREE.OctahedronGeometry(0.32, 0)
      const satMat = new THREE.MeshBasicMaterial({ color: orbit.color })
      const haloGeo = new THREE.SphereGeometry(0.6, 16, 16)
      const haloMat = new THREE.MeshBasicMaterial({ color: orbit.color, transparent: true, opacity: 0.18 })
      sat.add(new THREE.Mesh(satGeo, satMat), new THREE.Mesh(haloGeo, haloMat))
      plane.add(sat)
      satellites.push({ mesh: sat, orbit, phase: (i / ORBITS.length) * Math.PI * 2 })
      disposables.push(ringGeo, ringMat, satGeo, satMat, haloGeo, haloMat)
    })

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(h, 1)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()

    let visible = false
    const io = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    io.observe(mount)

    const clock = new THREE.Clock()
    let frame = 0
    const render = () => {
      frame = requestAnimationFrame(render)
      if (!visible) return
      const t = reduceMotion ? 0 : clock.getElapsedTime()
      coreWire.rotation.set(t * 0.3, t * 0.4, 0)
      shell.scale.setScalar(1 + Math.sin(t * 2) * 0.04)
      root.rotation.y = t * 0.08
      satellites.forEach(({ mesh, orbit, phase }) => {
        const a = phase + t * orbit.speed
        mesh.position.set(Math.cos(a) * orbit.radius, Math.sin(a) * orbit.radius, 0)
        mesh.rotation.set(t, t * 1.3, 0)
      })
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
