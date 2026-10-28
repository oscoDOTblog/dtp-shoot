/**
 * DTP Shoot — range enclosure.
 *
 * Local frame: origin on the floor at the back of the bay, +Y up, the wall face
 * points +Z toward the shooter. A concrete backstop and two side walls close
 * the bay so the range reads as a room instead of a stage in the dark. Envelope
 * is roughly 24 x 5 x 21 m.
 */

import { Group, MeshStandardMaterial, createScenePrimitiveObject } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';

const BAY_HALF_WIDTH = 8;
const BAY_DEPTH = 20.5;
const WALL_HEIGHT = 5;
const BACK_WALL_HEIGHT = 8;

const concrete = new MeshStandardMaterial({
  color: 0x34363b,
  roughness: 0.94,
  metalness: 0.02,
});

const berm = new MeshStandardMaterial({
  color: 0x2a2c30,
  roughness: 0.98,
  metalness: 0.0,
});

const hazard = new MeshStandardMaterial({
  color: 0x8a6435,
  roughness: 0.8,
  metalness: 0.05,
});

function box(
  size: [number, number, number],
  position: [number, number, number],
  material: MeshStandardMaterial,
  name: string,
): Object3D {
  const mesh = createScenePrimitiveObject(
    { geometry: { type: 'box', size } },
    material,
  );
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
}

export function createRangeBerm(): Object3D {
  const root = new Group();
  root.name = 'RangeBerm';

  // Backstop wall, with a darker absorbent panel behind the target line.
  root.add(
    box(
      [BAY_HALF_WIDTH * 2, BACK_WALL_HEIGHT, 0.4],
      [0, BACK_WALL_HEIGHT / 2, -BAY_DEPTH],
      concrete,
      'BackWall',
    ),
  );
  root.add(
    box(
      [13, 2.6, 0.12],
      [0, 1.5, -BAY_DEPTH + 0.26],
      berm,
      'BackstopPanel',
    ),
  );

  // Painted safety band along the base of the backstop.
  root.add(
    box(
      [13, 0.1, 0.14],
      [0, 0.35, -BAY_DEPTH + 0.27],
      hazard,
      'SafetyBand',
    ),
  );

  // Structural beam breaks up the back wall and reads as a roof edge.
  root.add(
    box(
      [BAY_HALF_WIDTH * 2, 0.5, 0.5],
      [0, 5.4, -BAY_DEPTH + 0.3],
      berm,
      'TopBeam',
    ),
  );

  // Side walls keep the eye inside the bay and bounce fill light back in.
  for (const side of [-1, 1]) {
    root.add(
      box(
        [0.4, WALL_HEIGHT, BAY_DEPTH - 1.5],
        [side * BAY_HALF_WIDTH, WALL_HEIGHT / 2, -BAY_DEPTH / 2 + 0.25],
        concrete,
        side < 0 ? 'LeftWall' : 'RightWall',
      ),
    );
  }

  return root;
}
