/**
 * DTP Shoot — range floor.
 *
 * Local frame: origin on the floor at the firing line, +Y up, down-range is -Z.
 * A dark asphalt slab replaces the scaffold's clay stage so the range reads as
 * an indoor shooting bay and the white steel targets stay the brightest thing
 * on screen. Lane dividers and a firing line are painted in, which gives the
 * player depth cues without extra lights. Envelope is 44 x 0.002 x 44 m.
 */

import {
  Group,
  MeshStandardMaterial,
  createSceneMaterial,
  createScenePrimitiveObject,
} from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';

const FLOOR_SIZE = 44;

const asphalt = createSceneMaterial({
  id: 'range-asphalt',
  model: 'standard',
  baseColor: '#33363c',
  roughness: 0.92,
  textures: {
    albedo: {
      type: 'procedural',
      algorithm: 'periodic-fbm-v1',
      resolution: [256, 256],
      seed: 21,
      bands: [
        { frequency: [70, 70], amplitude: 0.55 },
        { frequency: [190, 190], amplitude: 0.45 },
      ],
      ramp: [
        { at: 0, color: '#2b2e33' },
        { at: 1, color: '#3d4047' },
      ],
      sampler: { repeat: [22, 22] },
    },
    roughness: {
      type: 'procedural',
      algorithm: 'periodic-fbm-v1',
      resolution: [128, 128],
      seed: 22,
      bands: [{ frequency: [40, 40], amplitude: 1 }],
      range: [0.86, 0.96],
      sampler: { repeat: [22, 22] },
    },
  },
});

const paint = new MeshStandardMaterial({
  color: 0x6a7078,
  roughness: 0.82,
  metalness: 0.02,
});

const amberPaint = new MeshStandardMaterial({
  color: 0xa86f2c,
  roughness: 0.68,
  metalness: 0.05,
});

/** Flat painted stripe lying on the floor at `y = 0.002`. */
function stripe(
  width: number,
  depth: number,
  x: number,
  z: number,
  material: MeshStandardMaterial,
): Object3D {
  const mesh = createScenePrimitiveObject(
    { geometry: { type: 'plane', size: [width, depth] } },
    material,
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.002, z);
  mesh.receiveShadow = true;
  return mesh;
}

export function createRangeFloor(): Object3D {
  const root = new Group();
  root.name = 'RangeFloor';

  const slab = createScenePrimitiveObject(
    { geometry: { type: 'plane', size: [FLOOR_SIZE, FLOOR_SIZE] } },
    asphalt,
  );
  slab.rotation.x = -Math.PI / 2;
  slab.receiveShadow = true;
  slab.name = 'Slab';
  root.add(slab);

  // Firing line the player stands behind.
  root.add(stripe(7.2, 0.14, 0, -1.62, amberPaint));

  // Lane dividers running down-range; they converge with perspective and make
  // the pop-up distances legible.
  for (const x of [-2.7, -1.35, 0, 1.35, 2.7]) {
    root.add(stripe(0.07, 9.6, x, -6.6, paint));
  }

  // Distance ticks across the dividers at 5 m and 10 m.
  for (const z of [-6.0, -11.0]) {
    root.add(stripe(7.2, 0.07, 0, z, paint));
  }

  return root;
}
