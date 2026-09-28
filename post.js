// Parkwise post-processing + image-based lighting (loaded lazily by main.js).
// Addons are vendored from the same three.js revision as the core build (r185).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Colour grade + vignette: gentle S-curve, a touch more saturation, warm
// highlights / cool shadows; HDR overshoot is kept for the output pass.
const GradeShader = {
    uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      vec3 lc = clamp(c, 0.0, 1.0);
      vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.98, 1.04), vec3(1.03, 1.0, 0.97), smoothstep(0.2, 0.8, l));
      c = mix(c, s + max(c - 1.0, 0.0), uAmount);
      float d = length(vUv - 0.5);
      c *= 1.0 - uVignette * smoothstep(0.38, 0.85, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

/** Prefiltered studio environment for PBR reflections. */
export function makeEnvironment(renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const rt = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    return rt.texture;
}

/**
 * Build the post chain: Render → GTAO → Bloom → Grade → Output → SMAA/FXAA.
 * `g` is the resolved quality; `msaa` asks for a multisampled scene target.
 */
export function buildComposer(renderer, scene, camera, g, w, h, ratio, msaa) {
    const pw = Math.max(1, Math.round(w * ratio)), ph = Math.max(1, Math.round(h * ratio));
    const target = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: msaa ? 4 : 0 });
    const composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(ratio);
    composer.setSize(w, h);
    composer.addPass(new RenderPass(scene, camera));
    if (g.ao !== 'off') {
        const ao = new GTAOPass(scene, camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        const hi = g.ao === 'high';
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: hi ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 });
        composer.addPass(ao);
    }
    // High threshold: only emissive lights (gate, lamps, head/tail lights) bloom.
    if (g.bloom === 'on') composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.35, 0.92));
    if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
    composer.addPass(new OutputPass());
    if (g.antialias === 'smaa') composer.addPass(new SMAAPass());
    if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
    }
    return composer;
}
