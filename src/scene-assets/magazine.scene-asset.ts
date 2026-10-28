/**
 * DTP Shoot — spare pistol magazine.
 *
 * Local frame: origin at the bottom of the baseplate (so it stands on the
 * bench), +Y up, +Z toward the pistol's front. Envelope is roughly
 * 0.036 x 0.106 x 0.056 m, matching the pistol's grip well so the reload reads
 * as "that mag belongs to that gun".
 *
 * `Rounds` is a named runtime hook: the reload system hides it while the
 * magazine is spent, so a used mag looks empty instead of loaded.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
} from '@iwsdk/core';
import type { BufferGeometry, Material, Object3D } from '@iwsdk/core';
import { bevelBox } from './lib/hardsurface.js';

const BASEPLATE_HEIGHT = 0.011;
const BODY_HEIGHT = 0.086;
const BODY_TOP = BASEPLATE_HEIGHT + BODY_HEIGHT;

function createMaterials() {
  return {
    polymer: new MeshStandardMaterial({
      color: 0x24282d,
      metalness: 0.08,
      roughness: 0.68,
    }),
    gunmetal: new MeshStandardMaterial({
      color: 0x3a4149,
      metalness: 0.7,
      roughness: 0.42,
    }),
    steel: new MeshStandardMaterial({
      color: 0x848b94,
      metalness: 0.88,
      roughness: 0.34,
    }),
    brass: new MeshStandardMaterial({
      color: 0xb98a3e,
      metalness: 0.82,
      roughness: 0.3,
    }),
    paint: new MeshStandardMaterial({
      color: 0xc07a2c,
      metalness: 0.15,
      roughness: 0.5,
    }),
  };
}

function addMesh(
  parent: Object3D,
  geometry: BufferGeometry,
  material: Material,
  position: [number, number, number],
): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

export function createMagazine(): Object3D {
  const materials = createMaterials();
  const root = new Group();
  root.name = 'Magazine';

  // Sheet-steel tube with a slight forward rake, like a double-stack 9mm mag.
  const body = addMesh(
    root,
    bevelBox(0.026, BODY_HEIGHT, 0.046, 0.0016),
    materials.polymer,
    [0, BASEPLATE_HEIGHT + BODY_HEIGHT / 2, 0],
  );
  body.name = 'Body';

  // Baseplate: wider than the tube so it reads as a floorplate on the bench.
  addMesh(
    root,
    bevelBox(0.036, BASEPLATE_HEIGHT, 0.056, 0.0014),
    materials.gunmetal,
    [0, BASEPLATE_HEIGHT / 2, 0.002],
  ).name = 'Baseplate';

  // Orange paint band makes a dark mag readable against the dark bench top.
  addMesh(
    root,
    bevelBox(0.0375, 0.004, 0.012, 0.0008),
    materials.paint,
    [0, BASEPLATE_HEIGHT * 0.45, -0.021],
  ).name = 'PaintBand';

  // Witness holes down both flats, counting rounds left.
  for (let i = 0; i < 5; i += 1) {
    const y = 0.026 + i * 0.0125;
    for (const side of [-1, 1]) {
      addMesh(
        root,
        new CylinderGeometry(0.0022, 0.0022, 0.0012, 8),
        materials.steel,
        [side * 0.0132, y, 0.004],
      ).rotation.z = Math.PI / 2;
    }
  }

  // Spine ribs: two shallow creases that catch the stall light.
  for (const z of [-0.012, 0.014]) {
    addMesh(
      root,
      new BoxGeometry(0.0272, 0.058, 0.0016),
      materials.gunmetal,
      [0, 0.05, z],
    ).name = 'Rib';
  }

  // Magazine catch notch on the front strap.
  addMesh(
    root,
    bevelBox(0.012, 0.008, 0.003, 0.0006),
    materials.steel,
    [0, 0.083, -0.0242],
  ).name = 'CatchNotch';

  // Feed lips.
  for (const side of [-1, 1]) {
    addMesh(
      root,
      bevelBox(0.009, 0.007, 0.032, 0.0008),
      materials.steel,
      [side * 0.0085, BODY_TOP + 0.002, -0.004],
    ).name = 'FeedLip';
  }

  // The top round sits in the lips; hiding this group reads as an empty mag.
  const rounds = new Group();
  rounds.name = 'Rounds';
  root.add(rounds);

  const caseMesh = addMesh(
    rounds,
    new CylinderGeometry(0.0049, 0.0049, 0.019, 14),
    materials.brass,
    [0, BODY_TOP - 0.004, -0.002],
  );
  caseMesh.rotation.x = Math.PI / 2;
  addMesh(
    rounds,
    new CylinderGeometry(0.0036, 0.0047, 0.006, 14),
    materials.brass,
    [0, BODY_TOP - 0.004, -0.0135],
  ).rotation.x = Math.PI / 2;

  return root;
}
