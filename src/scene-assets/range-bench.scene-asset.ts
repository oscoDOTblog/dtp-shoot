/**
 * DTP Shoot — shooting bench.
 *
 * Local frame: origin on the floor at the centre of the bench, +Y up, +Z toward
 * the firing line. The top surface is at 0.93 m, which is a comfortable rest
 * height for a standing player and leaves room to reach the pistol. Envelope is
 * roughly 1.36 x 0.99 x 0.64 m.
 */

import { Group, Mesh, MeshStandardMaterial } from '@iwsdk/core';
import type { BufferGeometry, Material, Object3D } from '@iwsdk/core';
import { bevelBox } from './lib/hardsurface.js';

const TOP_HEIGHT = 0.93;
const TOP_THICKNESS = 0.06;

function createMaterials() {
  return {
    top: new MeshStandardMaterial({
      color: 0x33383e,
      metalness: 0.35,
      roughness: 0.52,
    }),
    frame: new MeshStandardMaterial({
      color: 0x1f2226,
      metalness: 0.25,
      roughness: 0.68,
    }),
    trim: new MeshStandardMaterial({
      color: 0x8f5a2a,
      metalness: 0.2,
      roughness: 0.55,
    }),
  };
}

function addMesh(
  parent: Object3D,
  geometry: BufferGeometry,
  material: Material,
  position: [number, number, number],
): void {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
}

export function createRangeBench(): Object3D {
  const materials = createMaterials();
  const root = new Group();
  root.name = 'RangeBench';

  addMesh(
    root,
    bevelBox(1.36, TOP_THICKNESS, 0.64, 0.008),
    materials.top,
    [0, TOP_HEIGHT - TOP_THICKNESS / 2, 0],
  );

  for (const side of [-1, 1]) {
    addMesh(
      root,
      bevelBox(0.06, TOP_HEIGHT - TOP_THICKNESS, 0.56, 0.006),
      materials.frame,
      [side * 0.62, (TOP_HEIGHT - TOP_THICKNESS) / 2, 0],
    );
  }

  addMesh(
    root,
    bevelBox(1.24, 0.14, 0.05, 0.005),
    materials.frame,
    [0, 0.16, 0.24],
  );

  // Rest rail keeps the pistol visually seated on the bench.
  addMesh(
    root,
    bevelBox(0.5, 0.02, 0.05, 0.006),
    materials.trim,
    [0.28, TOP_HEIGHT + 0.008, 0.16],
  );

  return root;
}
