import { useEffect, useRef, useState } from "react";
import {
  AmbientLight, CanvasTexture, DirectionalLight, Group, Mesh, MeshBasicMaterial, OrthographicCamera,
  PlaneGeometry, Scene, SRGBColorSpace, WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { drawFace, type MascotExpression } from "./faces";

const defaultPose = { x: 0, y: 0 };

function disposeMeshes(group: Group) {
  const geometries = new Set<import("three").BufferGeometry>();
  const materials = new Set<import("three").Material>();
  group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    const entries = Array.isArray(object.material) ? object.material : [object.material];
    entries.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

async function makeMascot(canvas: HTMLCanvasElement, signal: AbortSignal, firstPose: MascotExpression) {
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = 256;
  faceCanvas.height = 144;
  const context = faceCanvas.getContext("2d");
  if (!context) return null;
  const faceContext = context;

  const response = await fetch(`${import.meta.env.BASE_URL}cx-mascot.glb`, { signal });
  if (!response.ok) return null;
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(await response.arrayBuffer(), "");
  const model = gltf.scene;
  if (signal.aborted) {
    disposeMeshes(model);
    return null;
  }

  const byName = (name: string) => model.getObjectByName(name) ?? model.getObjectByName(name.replace(/ /g, "_"));
  const helmet = byName("Cloud helmet");
  const display = byName("Face display");
  const head = new Group();
  head.position.set(0, 2.19, 0);
  model.add(head);
  model.updateMatrixWorld(true);
  if (helmet && display) {
    head.attach(helmet);
    head.attach(display);
    for (const name of ["Left happy eye", "Right happy eye", "Smile"]) {
      const detail = byName(name);
      if (detail) detail.visible = false;
    }
  }

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  } catch {
    disposeMeshes(model);
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearAlpha(0);

  const camera = new OrthographicCamera(-1.5, 1.5, 1.86, -1.86, .1, 30);
  camera.position.set(.08, 1.76, 8);
  camera.lookAt(0, 1.57, 0);
  const scene = new Scene();
  const key = new DirectionalLight("#fff8ff", 2.22);
  key.position.set(-2, 4, 6);
  const fill = new DirectionalLight("#a0b7ff", 1.1);
  fill.position.set(3, 2, -2);
  scene.add(new AmbientLight("#b7c4ef", 1.3), key, fill, model);

  const texture = new CanvasTexture(faceCanvas);
  texture.colorSpace = SRGBColorSpace;
  const face = new Mesh(new PlaneGeometry(1.37, .8),
    new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
  face.position.set(0, -.04, .621);
  if (helmet && display) head.add(face);

  let pose = firstPose;
  let frame = 0;
  let lastTime = 0;
  const current: { x: number; y: number; tilt: number } = { ...defaultPose, tilt: pose.tilt };
  let target = defaultPose;
  let previousTexture = "";
  let stage = canvas.getBoundingClientRect();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const pointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  function render() {
    const gazeX = Math.round(current.x * 12);
    const gazeY = Math.round(current.y * 8);
    const signature = `${pose.label}:${gazeX}:${gazeY}`;
    if (previousTexture !== signature) {
      drawFace(faceContext, pose, gazeX, gazeY);
      texture.needsUpdate = true;
      previousTexture = signature;
    }
    head.rotation.set(current.y * .20, current.x * .32, current.tilt);
    renderer.render(scene, camera);
  }
  function resize() {
    stage = canvas.getBoundingClientRect();
    const width = Math.max(1, stage.width);
    const height = Math.max(1, stage.height);
    camera.left = -1.86 * width / height;
    camera.right = -camera.left;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    render();
  }
  function step(time: number) {
    frame = 0;
    const ease = 1 - Math.exp(-Math.min(lastTime ? time - lastTime : 16, 50) / 72);
    lastTime = time;
    const next = { ...target, tilt: pose.tilt };
    let moving = false;
    for (const key of ["x", "y", "tilt"] as const) {
      const remaining = next[key] - current[key];
      if (Math.abs(remaining) > .003) {
        current[key] += remaining * ease;
        moving = true;
      } else {
        current[key] = next[key];
      }
    }
    render();
    if (moving) frame = requestAnimationFrame(step);
  }
  function animate() {
    if (motion.matches || document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      Object.assign(current, defaultPose, { tilt: pose.tilt });
      render();
      return;
    }
    if (!frame) {
      lastTime = 0;
      frame = requestAnimationFrame(step);
    }
  }
  function follow(event: PointerEvent) {
    if (event.pointerType !== "mouse" || !pointer.matches || motion.matches) return;
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    target = {
      x: clamp((event.clientX - stage.left - stage.width / 2) / Math.max(190, window.innerWidth * .55)),
      y: clamp((event.clientY - stage.top - stage.height / 2) / Math.max(170, window.innerHeight * .60)),
    };
    animate();
  }
  function reset() {
    target = defaultPose;
    animate();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  window.addEventListener("pointermove", follow, { passive: true });
  document.documentElement.addEventListener("pointerleave", reset);
  window.addEventListener("blur", reset);
  motion.addEventListener("change", reset);
  pointer.addEventListener("change", reset);
  resize();

  return {
    setPose(nextPose: MascotExpression) {
      pose = nextPose;
      render();
      animate();
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", follow);
      document.documentElement.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
      motion.removeEventListener("change", reset);
      pointer.removeEventListener("change", reset);
      if (!face.parent) {
        face.geometry.dispose();
        face.material.dispose();
      }
      texture.dispose();
      disposeMeshes(model);
      renderer.dispose();
    },
  };
}

type Renderer = Awaited<ReturnType<typeof makeMascot>>;

export default function MascotModel({ pose }: { pose: MascotExpression }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Renderer>(null);
  const latest = useRef(pose);
  latest.current = pose;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!canvas.current) return;
    const target = canvas.current;
    const controller = new AbortController();
    void makeMascot(target, controller.signal, latest.current).then((model) => {
      if (controller.signal.aborted) {
        model?.dispose();
        return;
      }
      scene.current = model;
      model?.setPose(latest.current);
      setReady(Boolean(model));
    }).catch(() => {});
    const lost = (event: Event) => {
      event.preventDefault();
      setReady(false);
    };
    const restored = () => {
      scene.current?.setPose(latest.current);
      setReady(Boolean(scene.current));
    };
    target.addEventListener("webglcontextlost", lost);
    target.addEventListener("webglcontextrestored", restored);
    return () => {
      controller.abort();
      target.removeEventListener("webglcontextlost", lost);
      target.removeEventListener("webglcontextrestored", restored);
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.setPose(pose);
  }, [pose]);

  return (
    <span className="mascot-model" data-renderer={ready ? "webgl" : "fallback"} aria-hidden="true">
      {!ready && <span className="mascot-fallback"><i /><b>CX</b></span>}
      <canvas ref={canvas} />
    </span>
  );
}
