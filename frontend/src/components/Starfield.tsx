import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/** A fixed, full-page 3D starfield behind every page; drifts slowly and parallaxes on scroll. */
export default function Starfield() {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    mount.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400)
    camera.position.z = 50

    const COUNT = 1400
    const pos = new Float32Array(COUNT * 3)
    const col = new Float32Array(COUNT * 3)
    const palette = [0x9aa4c7, 0x7c9cff, 0x9f7aea, 0x3ee6c1, 0xffffff]
    const c = new THREE.Color()
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 260
      pos[i * 3 + 1] = (Math.random() - 0.5) * 260
      pos[i * 3 + 2] = (Math.random() - 0.5) * 200 - 40
      c.setHex(palette[i % palette.length]).multiplyScalar(0.5 + Math.random() * 0.5)
      c.toArray(col, i * 3)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const mat = new THREE.PointsMaterial({ size: 0.45, vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false })
    const stars = new THREE.Points(geo, mat)
    scene.add(stars)

    const resize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight, false)
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', resize)
    resize()

    let frame = 0
    const clock = new THREE.Clock()
    const render = () => {
      frame = requestAnimationFrame(render)
      if (document.hidden) return
      const t = clock.getElapsedTime()
      if (!reduceMotion) {
        stars.rotation.z = t * 0.005
        stars.rotation.y = t * 0.008
        camera.position.y += (-window.scrollY * 0.02 - camera.position.y) * 0.08
      }
      renderer.render(scene, camera)
    }
    render()

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      geo.dispose()
      mat.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mountRef} className="starfield" aria-hidden />
}
