"use client"

import { useEffect, useRef } from "react"
import * as THREE from "three"

export function HeroScene3D() {
  const mountRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    camera.position.set(0, 1.8, 8.6)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)
    let frameId = 0

    const root = new THREE.Group()
    root.position.set(0, 0.78, 0)
    root.scale.set(0.92, 0.92, 0.92)
    scene.add(root)

    const ambient = new THREE.AmbientLight(0xa7f3d0, 1.4)
    scene.add(ambient)

    const keyLight = new THREE.DirectionalLight(0x7dd3fc, 3.2)
    keyLight.position.set(4, 6, 5)
    scene.add(keyLight)

    const rimLight = new THREE.PointLight(0x22d3ee, 32, 18)
    rimLight.position.set(-4, 1.8, 3)
    scene.add(rimLight)

    const cyanMaterial = new THREE.MeshStandardMaterial({
      color: 0x22d3ee,
      metalness: 0.4,
      roughness: 0.28,
      emissive: 0x083344,
      emissiveIntensity: 0.45,
    })
    const greenMaterial = new THREE.MeshStandardMaterial({
      color: 0x86efac,
      metalness: 0.28,
      roughness: 0.34,
      emissive: 0x052e16,
      emissiveIntensity: 0.35,
    })
    const panelMaterial = new THREE.MeshStandardMaterial({
      color: 0xe0f2fe,
      metalness: 0.18,
      roughness: 0.42,
      transparent: true,
      opacity: 0.18,
      emissive: 0x0e7490,
      emissiveIntensity: 0.35,
    })
    const darkLineMaterial = new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.28 })
    const floorLineMaterial = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.13 })
    const blueMaterial = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      metalness: 0.35,
      roughness: 0.28,
      emissive: 0x1e3a8a,
      emissiveIntensity: 0.45,
    })
    const amberMaterial = new THREE.MeshStandardMaterial({
      color: 0xfde68a,
      metalness: 0.18,
      roughness: 0.42,
      emissive: 0x713f12,
      emissiveIntensity: 0.34,
    })

    const cubeGeometry = new THREE.BoxGeometry(0.58, 0.58, 0.58)
    const shelfGroup = new THREE.Group()
    const cubeMeshes: THREE.Mesh[] = []

    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 7; column += 1) {
        const cube = new THREE.Mesh(cubeGeometry, (row + column) % 2 === 0 ? cyanMaterial : greenMaterial)
        cube.position.set((column - 3) * 0.78, row * 0.68 - 1.25, Math.sin(column * 0.7) * 0.24)
        cube.rotation.set(0.18, 0.18, 0)
        shelfGroup.add(cube)
        cubeMeshes.push(cube)
      }
    }
    shelfGroup.position.set(-5.15, 0.35, -1.6)
    shelfGroup.rotation.y = -0.32
    root.add(shelfGroup)

    const invoiceGroup = new THREE.Group()
    const panelGeometry = new THREE.BoxGeometry(2.25, 1.28, 0.06)
    for (let index = 0; index < 4; index += 1) {
      const panel = new THREE.Mesh(panelGeometry, panelMaterial)
      panel.position.set(0, index * -0.56, index * 0.18)
      panel.rotation.z = index * -0.035
      invoiceGroup.add(panel)

      const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.82, 0.24 + index * -0.56, 0.08 + index * 0.18),
        new THREE.Vector3(0.82, 0.24 + index * -0.56, 0.08 + index * 0.18),
        new THREE.Vector3(-0.82, index * -0.56, 0.08 + index * 0.18),
        new THREE.Vector3(0.52, index * -0.56, 0.08 + index * 0.18),
      ])
      invoiceGroup.add(new THREE.LineSegments(lineGeometry, darkLineMaterial))
    }
    invoiceGroup.position.set(4.75, 1.55, -1)
    invoiceGroup.rotation.set(-0.12, -0.48, 0.08)
    root.add(invoiceGroup)

    const dashboardGroup = new THREE.Group()
    const dashboardShell = new THREE.Mesh(new THREE.BoxGeometry(2.55, 1.55, 0.1), panelMaterial)
    dashboardGroup.add(dashboardShell)
    const barGeometry = new THREE.BoxGeometry(0.18, 0.52, 0.1)
    const dashboardBars: THREE.Mesh[] = []
    for (let index = 0; index < 6; index += 1) {
      const bar = new THREE.Mesh(barGeometry, index % 2 ? greenMaterial : blueMaterial)
      bar.position.set(-0.9 + index * 0.36, -0.35 + (index % 3) * 0.08, 0.14)
      bar.scale.y = 0.55 + index * 0.14
      dashboardGroup.add(bar)
      dashboardBars.push(bar)
    }
    const dashboardTrend = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-1.05, 0.38, 0.16),
        new THREE.Vector3(-0.58, 0.12, 0.16),
        new THREE.Vector3(-0.12, 0.32, 0.16),
        new THREE.Vector3(0.34, 0.02, 0.16),
        new THREE.Vector3(0.98, 0.48, 0.16),
      ]),
      darkLineMaterial
    )
    dashboardGroup.add(dashboardTrend)
    dashboardGroup.position.set(5.05, -0.28, -1.35)
    dashboardGroup.rotation.set(-0.1, -0.62, 0.05)
    root.add(dashboardGroup)

    const posGroup = new THREE.Group()
    const posBase = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.34, 0.94), blueMaterial)
    const posScreen = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.92, 0.08), panelMaterial)
    const posGlow = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.09), greenMaterial)
    posBase.position.set(0, -0.58, 0)
    posScreen.position.set(0, 0.08, -0.32)
    posScreen.rotation.x = -0.22
    posGlow.position.set(0, 0.14, -0.25)
    posGroup.add(posBase, posScreen, posGlow)
    posGroup.position.set(-4.95, -1.05, -0.72)
    posGroup.rotation.set(0.04, 0.54, -0.03)
    root.add(posGroup)

    const ringGeometry = new THREE.TorusGeometry(1.46, 0.012, 12, 100)
    const ringA = new THREE.Mesh(ringGeometry, cyanMaterial)
    const ringB = new THREE.Mesh(ringGeometry, greenMaterial)
    ringA.position.set(3.75, 0.58, -2.2)
    ringB.position.copy(ringA.position)
    ringA.rotation.x = Math.PI / 2.45
    ringB.rotation.y = Math.PI / 2.25
    root.add(ringA, ringB)

    const floorPoints: THREE.Vector3[] = []
    for (let i = -6; i <= 6; i += 1) {
      floorPoints.push(new THREE.Vector3(i, -2.25, -5), new THREE.Vector3(i, -2.25, 2.8))
      floorPoints.push(new THREE.Vector3(-6, -2.25, i * 0.65 - 1), new THREE.Vector3(6, -2.25, i * 0.65 - 1))
    }
    const floor = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(floorPoints), floorLineMaterial)
    root.add(floor)

    const connectionPoints = [
      new THREE.Vector3(-0.6, -0.2, -1.4),
      new THREE.Vector3(1.2, 0.4, -1.1),
      new THREE.Vector3(2.2, 0.4, -1),
      new THREE.Vector3(-1.6, 0.4, -1.6),
      new THREE.Vector3(0, 1.1, -2.2),
      new THREE.Vector3(2.3, 0.7, -1),
    ]
    const connections = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(connectionPoints), darkLineMaterial)
    root.add(connections)

    const nodeGeometry = new THREE.SphereGeometry(0.08, 18, 18)
    const orbitNodes: THREE.Mesh[] = []
    for (let index = 0; index < 9; index += 1) {
      const node = new THREE.Mesh(nodeGeometry, index % 3 === 0 ? amberMaterial : cyanMaterial)
      node.position.set(Math.cos(index) * 3.8, Math.sin(index * 1.7) * 1.15 + 0.35, -1.8 + Math.sin(index) * 0.4)
      root.add(node)
      orbitNodes.push(node)
    }

    const resize = () => {
      const width = mount.clientWidth
      const height = mount.clientHeight
      renderer.setSize(width, height, false)
      camera.aspect = width / Math.max(height, 1)
      camera.updateProjectionMatrix()
    }

    const startedAt = performance.now()
    const animate = (timestamp = performance.now()) => {
      const time = (timestamp - startedAt) / 1000
      root.rotation.y = Math.sin(time * 0.18) * 0.045
      shelfGroup.position.y = 0.35 + Math.sin(time * 0.9) * 0.11
      invoiceGroup.position.y = 1.55 + Math.cos(time * 0.8) * 0.12
      dashboardGroup.position.y = -0.28 + Math.sin(time * 0.7) * 0.12
      posGroup.position.y = -1.05 + Math.cos(time * 0.95) * 0.08
      ringA.rotation.z = time * 0.38
      ringB.rotation.x = time * 0.22
      dashboardBars.forEach((bar, index) => {
        bar.scale.y = 0.75 + Math.sin(time * 1.6 + index) * 0.28 + index * 0.08
      })
      orbitNodes.forEach((node, index) => {
        node.position.x = Math.cos(time * 0.38 + index) * (3.25 + (index % 2) * 0.65)
        node.position.y = Math.sin(time * 0.52 + index * 1.3) * 1.08 + 0.22
      })
      cubeMeshes.forEach((cube, index) => {
        cube.rotation.y = 0.18 + time * 0.34 + index * 0.035
        cube.position.y += Math.sin(time * 1.4 + index) * 0.0008
      })
      renderer.render(scene, camera)
      frameId = window.requestAnimationFrame(animate)
    }

    resize()
    animate()
    window.addEventListener("resize", resize)

    return () => {
      window.removeEventListener("resize", resize)
      window.cancelAnimationFrame(frameId)
      mount.removeChild(renderer.domElement)
      root.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments) {
          object.geometry.dispose()
        }
      })
      renderer.dispose()
      cyanMaterial.dispose()
      greenMaterial.dispose()
      panelMaterial.dispose()
      darkLineMaterial.dispose()
      floorLineMaterial.dispose()
      blueMaterial.dispose()
      amberMaterial.dispose()
    }
  }, [])

  return <div ref={mountRef} className="hero-scene-3d" aria-hidden="true" />
}
