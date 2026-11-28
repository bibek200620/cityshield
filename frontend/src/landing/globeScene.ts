import {
  AdditiveBlending, BufferGeometry, DirectionalLight, DoubleSide, Float32BufferAttribute,
  Group, HalfFloatType, HemisphereLight, MathUtils, Mesh, MeshDepthMaterial, MeshStandardMaterial,
  Object3D, PerspectiveCamera, PlaneGeometry, Points, RepeatWrapping, Scene, ShaderMaterial,
  SphereGeometry, Texture, TextureLoader, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { landMarkers } from "./landMarkers";
import {
  CONFIG, SNOISE, cloudFragment, finalShaders, haloShaders, markerShaders, moteShaders, planetFragment, starShaders,
} from "./globeShaders";

const ASSET_BASE_URL = "https://api.getlayers.ai/storage/v1/object/public/public/assets/ascend-d9857ad1f2";
const PLANET_GLB = `${ASSET_BASE_URL}/planet.glb`;
const PLANET_LIGHTS_GLB = `${ASSET_BASE_URL}/planet-lights.glb`;
const PLANET_CLOUDS_PNG = `${ASSET_BASE_URL}/planet-clouds.png`;
const ENTIRE_SCENE = 0, TORUS_SCENE = 1, BLOOM_SCENE = 2, HALO_SCENE = 3;
const STOPS_X = [{p:0,v:0},{p:0.32,v:-3.1},{p:0.64,v:3.2},{p:1,v:0}];
const STOPS_Y = [{p:0,v:-4.5},{p:0.32,v:0.55},{p:0.64,v:0.45},{p:1,v:0.15}];
const STOPS_S = [{p:0,v:2.15},{p:0.32,v:1.0},{p:0.64,v:0.92},{p:1,v:1.12}];
const ENTRY_DUR = 1.9, ENTRY_START_Y = -6.5;

const uniform = <T,>(value: T) => ({ value });

function hexToVec3(hex: string) {
  const rgb = Number.parseInt(hex.slice(1), 16);
  return new Vector3((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255).divideScalar(255);
}

function sample(stops: typeof STOPS_X, progress: number) {
  for (let i = 1; i < stops.length; i++) {
    const left = stops[i - 1], right = stops[i];
    if (progress <= right.p) {
      return MathUtils.lerp(left.v, right.v, MathUtils.smoothstep(progress, left.p, right.p));
    }
  }
  return stops[stops.length - 1].v;
}

type PlanetMesh = Mesh<BufferGeometry, MeshStandardMaterial>;

function firstTexturedMesh(root: Object3D) {
  let mesh: PlanetMesh | undefined;
  root.traverse((object) => {
    if (!mesh && object instanceof Mesh && object.material instanceof MeshStandardMaterial && object.material.map) {
      mesh = object;
    }
  });
  return mesh;
}

function disposeObjects(root: Object3D) {
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh || object instanceof Points)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
      material.dispose();
    }
  });

  const bitmaps = new Set<ImageBitmap>();
  for (const texture of textures) {
    texture.dispose();
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) bitmaps.add(texture.image);
  }
  for (const bitmap of bitmaps) bitmap.close();
}

function injectMaterial(
  material: MeshStandardMaterial,
  uv: string,
  uniforms: Record<string, { value: number | Vector3 | Texture }>,
  fragment: string,
) {
  const declarations = Object.entries(uniforms).map(([name, { value }]) => {
    const type = typeof value === "number" ? "float" : value instanceof Vector3 ? "vec3" : "sampler2D";
    return `uniform ${type} ${name};`;
  }).join("\n");
  material.customProgramCacheKey = () => uv;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const varying = `varying vec2 ${uv};\n`;
    shader.vertexShader = varying + shader.vertexShader.replace(
      "void main() {", `void main() {\n${uv} = uv;`,
    );
    shader.fragmentShader = `${varying}${declarations}\n${SNOISE}\n` +
      shader.fragmentShader.replace("#include <dithering_fragment>", fragment);
  };
}

export function createGlobe(host: HTMLDivElement, onReady: () => void, onUnavailable: () => void) {
  const renderer = new WebGLRenderer({ powerPreference: "low-power" });
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.setClearColor(0x000000);
  host.append(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(44, 1, 0.1, 150);
  camera.position.set(0, 0, 8.4);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.enabled = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = CONFIG.autoRotate;
  controls.minDistance = 3.5;
  controls.maxDistance = 16;
  controls.target.set(0, 0, 0);
  // The camera animation uses update(), so there is no need for input listeners.
  controls.disconnect();

  const worldGroup = new Group();
  worldGroup.position.set(STOPS_X[0].v, STOPS_Y[0].v, 0);
  worldGroup.scale.setScalar(STOPS_S[0].v);
  const planetGroup = new Group(), cloudGroup = new Group();
  planetGroup.rotation.set(0, CONFIG.initRotation, CONFIG.tilt, "ZXY");
  cloudGroup.rotation.z = CONFIG.tilt;
  cloudGroup.visible = false;
  worldGroup.add(planetGroup, cloudGroup);
  scene.add(worldGroup);

  const light = new DirectionalLight(0xf0f4ff, 2.1);
  light.position.set(-5, 1, 5);
  scene.add(light, new HemisphereLight(0xd3deff, 0x1a223b, 1.1));

  const halo = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  const haloMaterial = new ShaderMaterial({
    ...haloShaders, transparent: true, side: DoubleSide, depthWrite: false, blending: AdditiveBlending,
    uniforms: { uGlow: uniform(hexToVec3(CONFIG.glowColor)), uIntensity: uniform(CONFIG.glowIntensity) },
  });
  const glowMesh = new Mesh(new PlaneGeometry(2, 2), haloMaterial);
  glowMesh.scale.setScalar(CONFIG.planetRadius * 2.3);
  glowMesh.layers.set(HALO_SCENE);
  worldGroup.add(glowMesh);

  const torusComposer = new EffectComposer(renderer);
  const bloomComposer = new EffectComposer(renderer);
  const finalComposer = new EffectComposer(renderer);
  const torusBloom = new UnrealBloomPass(new Vector2(1, 1), 0.22, 0.2, 0);
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.5, 0.6, 0);
  torusComposer.renderToScreen = bloomComposer.renderToScreen = false;
  torusComposer.addPass(new RenderPass(scene, camera));
  torusComposer.addPass(torusBloom);
  bloomComposer.addPass(new RenderPass(scene, camera));
  bloomComposer.addPass(bloom);
  const finalPass = new ShaderPass({
    ...finalShaders,
    uniforms: {
      iTime: uniform(0), tDiffuse: uniform(null), torusTexture: uniform(null),
      bloomTexture: uniform(null), haloTexture: uniform(null),
      uBg: uniform(hexToVec3(CONFIG.bgColor)), uFlameA: uniform(hexToVec3(CONFIG.flameColor)),
      uFlameB: uniform(hexToVec3(CONFIG.flameColor2)), uFlameAmt: uniform(CONFIG.flameAmt),
    },
  });
  finalPass.uniforms.haloTexture.value = halo.texture;
  finalComposer.addPass(new RenderPass(scene, camera));
  finalComposer.addPass(finalPass);

  const resolution = new Vector2();
  const planetTime = uniform(0), cloudTime = uniform(0), starTime = uniform(0), markerTime = uniform(0);
  const moteTime = uniform(0);
  const cloudLayers = [
    { height: CONFIG.cloud1Height, opacity: CONFIG.cloud1Opacity, spin: CONFIG.cloud1Spin, ry: 0, phase: 0 },
    { height: CONFIG.cloud2Height, opacity: CONFIG.cloud2Opacity, spin: CONFIG.cloud2Spin, ry: 2.2, phase: 13 },
    { height: CONFIG.cloud3Height, opacity: CONFIG.cloud3Opacity, spin: CONFIG.cloud3Spin, ry: 4.3, phase: 27 },
  ];

  const motePositions = [], moteSizes = [], moteSeeds = [];
  for (let i = 0; i < CONFIG.atmoCount; i++) {
    motePositions.push(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
    moteSizes.push(CONFIG.atmoSize * (0.4 + Math.random()));
    moteSeeds.push(Math.random());
  }
  const moteGeometry = new BufferGeometry();
  moteGeometry.setAttribute("position", new Float32BufferAttribute(motePositions, 3));
  moteGeometry.setAttribute("size", new Float32BufferAttribute(moteSizes, 1));
  moteGeometry.setAttribute("seed", new Float32BufferAttribute(moteSeeds, 1));
  const motes = new Points(moteGeometry, new ShaderMaterial({
    ...moteShaders, transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false,
    uniforms: { uTime: moteTime, uRes: uniform(resolution), uColor: uniform(hexToVec3(CONFIG.atmoColor)) },
  }));
  motes.layers.set(TORUS_SCENE);
  motes.frustumCulled = false;
  motes.onBeforeRender = () => {
    moteTime.value = performance.now() / 1000 * CONFIG.atmoSpeed * 8;
    finalPass.uniforms.iTime.value = moteTime.value;
  };
  scene.add(motes);

  const starPositions = [], starSeeds = [], starBrightness = [];
  for (let i = 0; i < CONFIG.starCount; i++) {
    const z = Math.random() * 2 - 1;
    const azimuth = Math.random() * 2 * Math.PI;
    const r = Math.sqrt(1 - z * z) * 90;
    starPositions.push(r * Math.cos(azimuth), r * Math.sin(azimuth), z * 90);
    starSeeds.push(Math.random() * 2 * Math.PI);
    starBrightness.push(0.35 + Math.random() * 0.65);
  }
  const starGeometry = new BufferGeometry();
  starGeometry.setAttribute("position", new Float32BufferAttribute(starPositions, 3));
  starGeometry.setAttribute("seed", new Float32BufferAttribute(starSeeds, 1));
  starGeometry.setAttribute("bright", new Float32BufferAttribute(starBrightness, 1));
  const stars = new Points(starGeometry, new ShaderMaterial({
    ...starShaders, transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true,
    uniforms: {
      uTime: starTime, uSize: uniform(CONFIG.starSize), uFlicker: uniform(CONFIG.starFlicker),
      uColor: uniform(hexToVec3(CONFIG.starColor)), uRes: uniform(resolution),
    },
  }));
  stars.layers.set(BLOOM_SCENE);
  stars.frustumCulled = false;
  scene.add(stars);

  const draco = new DRACOLoader()
    .setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.5/")
    .setWorkerLimit(1);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const depthMaterial = new MeshDepthMaterial({ colorWrite: false, side: DoubleSide });
  const gltfRoots: Object3D[] = [];
  let planet: Mesh<BufferGeometry, MeshStandardMaterial | MeshDepthMaterial> | undefined;
  let disposed = false, suspended = false, failed = false;
  let ready = false;
  let frame = 0;
  let previous: number | undefined;
  let curP = 0, curX = STOPS_X[0].v, curY = STOPS_Y[0].v, curS = STOPS_S[0].v;
  let spinPhase = 0, entranceElapsed = 0;

  function loadClouds(texture: Texture) {
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.repeat.set(5, 5);
    for (const layer of cloudLayers) {
      const material = new MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false });
      injectMaterial(material, "vCloudUv", {
        uTime: cloudTime, noiseScale: uniform(20), uSpeedX: uniform(1), uSpeedY: uniform(2), uSpeedZ: uniform(2),
        uOpacity: uniform(layer.opacity), uPhase: uniform(layer.phase),
      }, cloudFragment);
      const mesh = new Mesh(new SphereGeometry(CONFIG.planetRadius * layer.height, 64, 64), material);
      mesh.rotation.y = layer.ry;
      mesh.renderOrder = 2;
      cloudGroup.add(mesh);
    }
  }

  async function loadPlanet() {
    try {
      // A missing lights map leaves a renderable globe with the night-lights term set to zero.
      const lights = await loader.loadAsync(PLANET_LIGHTS_GLB).catch(() => null);
      if (lights) {
        if (disposed) disposeObjects(lights.scene);
        else gltfRoots.push(lights.scene);
      }
      if (disposed) return;
      const nightTex = lights && firstTexturedMesh(lights.scene)?.material.map;
      const model = await loader.loadAsync(PLANET_GLB);
      if (disposed) {
        disposeObjects(model.scene);
        return;
      }
      gltfRoots.push(model.scene);
      const mesh = firstTexturedMesh(model.scene);
      const map = mesh?.material.map;
      if (!mesh || !map) throw new Error("Earth texture unavailable");

      mesh.geometry.computeBoundingSphere();
      const radius = mesh.geometry.boundingSphere?.radius;
      if (!radius) throw new Error("Earth geometry unavailable");
      const originalMaterial = mesh.material;
      const material = originalMaterial.clone();
      originalMaterial.dispose();
      material.metalness = 0;
      material.roughness = 1;
      material.envMapIntensity = 0;
      injectMaterial(material, "vCustomUv", {
        time: planetTime, noiseScale: uniform(30), speedX: uniform(1.5), speedY: uniform(2), speedZ: uniform(2.5),
        rimColor: uniform(hexToVec3(CONFIG.rimColor)), rimPower: uniform(CONFIG.rimPower),
        nightBlendTexture: uniform(nightTex || map), nightLights: uniform(nightTex ? CONFIG.nightLights : 0),
        terrainDepth: uniform(CONFIG.terrainDepth), terrainShade: uniform(CONFIG.terrainShade),
        oceanGlint: uniform(CONFIG.oceanGlint), oceanDeep: uniform(CONFIG.oceanDeep), oceanFlow: uniform(CONFIG.oceanFlow),
        oceanFlowSpeed: uniform(CONFIG.oceanFlowSpeed), oceanFlowScale: uniform(CONFIG.oceanFlowScale),
      }, planetFragment);
      mesh.material = material;
      mesh.scale.setScalar(CONFIG.planetRadius / radius);
      mesh.layers.enable(HALO_SCENE);
      mesh.layers.enable(BLOOM_SCENE);

      let markers: BufferGeometry | null = null;
      try {
        markers = landMarkers(mesh.geometry, map, CONFIG.markerCount);
      } catch {
        // A browser that denies texture readback can still render the Earth.
      }
      if (markers) {
        mesh.add(new Points(markers, new ShaderMaterial({
          ...markerShaders, transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true,
          uniforms: {
            uTime: markerTime, uRes: uniform(resolution), uSize: uniform(CONFIG.markerSize),
            uSpeed: uniform(CONFIG.markerSpeed), uColor: uniform(hexToVec3(CONFIG.markerColor)),
          },
        })));
      }

      planet = mesh;
      worldGroup.position.y = curY + ENTRY_START_Y;
      planetGroup.add(mesh);
      cloudGroup.visible = true;
    } catch {
      if (!disposed) unavailable();
    } finally {
      draco.dispose();
    }
  }

  function render(dt: number) {
    controls.update(dt);
    glowMesh.quaternion.copy(camera.quaternion);
    motes.position.copy(camera.position);
    // Offscreen light layers use the opaque planet as a depth mask.
    const material = planet?.material;
    if (planet) planet.material = depthMaterial;
    camera.layers.set(HALO_SCENE);
    renderer.setRenderTarget(halo);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    camera.layers.set(TORUS_SCENE);
    torusComposer.render(dt);
    camera.layers.set(BLOOM_SCENE);
    bloomComposer.render(dt);

    if (planet && material) planet.material = material;
    finalPass.uniforms.torusTexture.value = torusComposer.readBuffer.texture;
    finalPass.uniforms.bloomTexture.value = bloomComposer.readBuffer.texture;
    camera.layers.set(ENTIRE_SCENE);
    finalComposer.render(dt);
  }

  function tick(now: number) {
    frame = 0;
    const dt = previous === undefined ? 0 : Math.min(0.05, (now - previous) / 1000);
    previous = now;
    const scrollRange = document.documentElement.scrollHeight - window.innerHeight;
    const target = scrollRange > 0 ? MathUtils.clamp(window.scrollY / scrollRange, 0, 1) : 0;
    curP += (target - curP) * Math.min(1, dt * 4.5);
    const sideScale = MathUtils.clamp(window.innerWidth / 1200, 0.5, 1);
    const k = Math.min(1, dt * 3.2);
    curX += (sample(STOPS_X, curP) * sideScale - curX) * k;
    curY += (sample(STOPS_Y, curP) - curY) * k;
    curS += (sample(STOPS_S, curP) - curS) * k;
    if (planet) entranceElapsed = Math.min(ENTRY_DUR, entranceElapsed + dt);
    const eased = 1 - (1 - entranceElapsed / ENTRY_DUR) ** 3;
    worldGroup.position.set(curX, curY + ENTRY_START_Y * (1 - eased), 0);
    worldGroup.scale.setScalar(curS);
    spinPhase += dt * CONFIG.spin;
    planetGroup.rotation.y = CONFIG.initRotation + spinPhase + curP * Math.PI * 1.6;
    cloudGroup.children.forEach((cloud, i) => { cloud.rotation.y += dt * cloudLayers[i].spin; });
    planetTime.value += dt / 12;
    cloudTime.value += dt / 20;
    starTime.value += dt;
    markerTime.value += dt;
    render(dt);
    if (planet && !ready) {
      ready = true;
      onReady();
    }
    schedule();
  }

  function schedule() {
    if (!disposed && !suspended && !failed && !document.hidden && !frame) {
      frame = requestAnimationFrame(tick);
    }
  }

  function cancelFrame() {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = undefined;
  }

  function unavailable() {
    failed = true;
    cancelFrame();
    onUnavailable();
  }

  function resize() {
    const { clientWidth: width, clientHeight: height } = host;
    if (!width || !height || failed) return;
    const pixelRatio = Math.min(window.devicePixelRatio, 1.5, Math.sqrt(2_600_000 / (width * height)));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    for (const composer of [torusComposer, bloomComposer, finalComposer]) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
    }
    renderer.getDrawingBufferSize(resolution);
    halo.setSize(resolution.x, resolution.y);
    if (suspended) render(0);
  }

  function visibilityChanged() {
    if (document.hidden) cancelFrame();
    else schedule();
  }

  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", visibilityChanged);
  renderer.domElement.addEventListener("webglcontextlost", unavailable);
  void loadPlanet();
  void new TextureLoader().loadAsync(PLANET_CLOUDS_PNG).then((texture) => {
    if (disposed || failed) texture.dispose();
    else loadClouds(texture);
  }).catch(() => {
    // Clouds are an optional foreground layer.
  });
  schedule();

  return {
    setPaused(paused: boolean) {
      suspended = paused;
      if (paused) cancelFrame();
      else schedule();
    },
    dispose() {
      disposed = true;
      cancelFrame();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibilityChanged);
      renderer.domElement.removeEventListener("webglcontextlost", unavailable);
      controls.dispose();
      disposeObjects(scene);
      for (const root of gltfRoots) disposeObjects(root);
      depthMaterial.dispose();
      halo.dispose();
      torusBloom.dispose();
      bloom.dispose();
      finalPass.dispose();
      for (const composer of [torusComposer, bloomComposer, finalComposer]) composer.dispose();
      renderer.dispose();
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
