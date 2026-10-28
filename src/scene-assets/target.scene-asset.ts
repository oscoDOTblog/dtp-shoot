/**
 * DTP Shoot — pop-up steel target.
 *
 * Local frame: origin on the floor at the hinge, +Y up, the face points +Z so a
 * target placed down-range faces a player standing at the scene origin.
 * `Arm` is the part that swings down after a hit, and `Head` is the scoring
 * plate used for hit tests. Envelope is roughly 0.45 x 1.1 x 0.2 m.
 */

import {
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  RingGeometry,
} from '@iwsdk/core';
import type { BufferGeometry, Material, Object3D } from '@iwsdk/core';
import { bevelBox } from './lib/hardsurface.js';

const HEAD_Y = 0.84;
const HEAD_RADIUS = 0.215;

function createMaterials() {
  return {
    steel: new MeshStandardMaterial({
      color: 0x4b5058,
      metalness: 0.8,
      roughness: 0.42,
    }),
    dark: new MeshStandardMaterial({
      color: 0x191b1e,
      metalness: 0.35,
      roughness: 0.6,
    }),
    face: new MeshStandardMaterial({
      color: 0xf3efe6,
      metalness: 0.05,
      roughness: 0.78,
    }),
    ring: new MeshStandardMaterial({
      color: 0x141518,
      metalness: 0.05,
      roughness: 0.72,
    }),
    bull: new MeshStandardMaterial({
      color: 0xd23a2c,
      metalness: 0.05,
      roughness: 0.66,
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
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Flat scoring decal ring / disc, stacked in tiny Z steps to avoid z-fighting. */
function addDisc(
  parent: Object3D,
  geometry: BufferGeometry,
  material: Material,
  z: number,
): Mesh {
  const mesh = addMesh(parent, geometry, material, [0, 0, z]);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function buildHead(materials: ReturnType<typeof createMaterials>): Group {
  const head = new Group();
  head.name = 'Head';

  const backing = addMesh(
    head,
    new CylinderGeometry(HEAD_RADIUS + 0.008, HEAD_RADIUS + 0.008, 0.014, 48),
    materials.steel,
    [0, 0, 0],
  );
  backing.rotation.x = Math.PI / 2;
  backing.name = 'Plate';

  addDisc(head, new CircleGeometry(HEAD_RADIUS, 48), materials.face, 0.0082);
  addDisc(head, new RingGeometry(0.152, 0.206, 48), materials.ring, 0.0092);
  addDisc(head, new RingGeometry(0.104, 0.152, 48), materials.face, 0.0102);
  addDisc(head, new RingGeometry(0.062, 0.104, 48), materials.ring, 0.0112);
  addDisc(head, new CircleGeometry(0.062, 48), materials.bull, 0.0122);
  addDisc(head, new CircleGeometry(0.018, 32), materials.face, 0.0132);

  // Cradle the plate where it meets the post.
  const bracket = addMesh(
    head,
    bevelBox(0.09, 0.05, 0.036, 0.004),
    materials.steel,
    [0, -HEAD_RADIUS + 0.012, -0.004],
  );
  bracket.name = 'Bracket';

  return head;
}

export function createTarget(): Object3D {
  const materials = createMaterials();

  const root = new Group();
  root.name = 'PopTarget';

  const base = new Group();
  base.name = 'Base';
  root.add(base);

  addMesh(base, bevelBox(0.36, 0.045, 0.22, 0.008), materials.steel, [
    0,
    0.0225,
    0,
  ]).name = 'BasePlate';

  addMesh(base, bevelBox(0.14, 0.05, 0.12, 0.006), materials.dark, [
    0,
    0.062,
    0,
  ]).name = 'HingeBlock';

  // The arm pivots on the hinge block and swings away from the player.
  const arm = new Group();
  arm.name = 'Arm';
  arm.position.set(0, 0.06, 0);
  root.add(arm);

  addMesh(arm, bevelBox(0.055, 0.75, 0.055, 0.006), materials.steel, [
    0,
    0.375,
    0,
  ]).name = 'Post';

  addMesh(arm, bevelBox(0.16, 0.03, 0.06, 0.005), materials.dark, [
    0,
    0.72,
    0,
  ]).name = 'Neck';

  const head = buildHead(materials);
  head.position.set(0, HEAD_Y - 0.06, 0.012);
  arm.add(head);

  return root;
}
