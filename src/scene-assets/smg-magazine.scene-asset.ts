/**
 * DTP Shoot — spare SMG magazine.
 *
 * Local frame: origin at the bottom of the baseplate (so it stands on the
 * bench), +Y up, +Z toward the weapon's front. The 30-round body is a single
 * swept loft with a gentle forward curve, taller and slimmer than the pistol
 * magazine, plus an orange paint band so the two read apart at arm's length.
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
import { bevelBox, LoftSurface, sampleRange } from './lib/hardsurface.js';

const BASEPLATE_HEIGHT = 0.013;
const BODY_BOTTOM = BASEPLATE_HEIGHT - 0.001;
const BODY_TOP = 0.198;
/** Forward offset of the body at its top, which gives the magazine its curve. */
const CURVE = 0.0115;

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
    // Invisible, but still raycast: this is the grab volume, not a visual.
    grab: new MeshStandardMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
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

/** Forward offset of the body centre at a given height, matching the loft. */
function curveAt(y: number): number {
  const t = Math.min(1, Math.max(0, (y - BODY_BOTTOM) / (BODY_TOP - BODY_BOTTOM)));
  return CURVE * t * t;
}

export function createSmgMagazine(): Object3D {
  const materials = createMaterials();
  const root = new Group();
  root.name = 'SmgMagazine';

  addMesh(
    root,
    bevelBox(0.042, BASEPLATE_HEIGHT, 0.074, 0.0014),
    materials.gunmetal,
    [0, BASEPLATE_HEIGHT / 2, 0.003],
  ).name = 'Baseplate';

  // One continuous body: the loft is swept along +Z, then stood up so the sweep
  // becomes the magazine's height and the section offsets become its curve.
  const surface = LoftSurface.tube([
    { z: BODY_BOTTOM, halfW: 0.0138, hUp: 0.0295, hDown: 0.0295, power: 3.2 },
    { z: 0.055, halfW: 0.0138, hUp: 0.0305, hDown: 0.0305, cy: 0.0012, power: 3.2 },
    { z: 0.11, halfW: 0.0134, hUp: 0.0295, hDown: 0.0295, cy: 0.0048, power: 3.2 },
    { z: 0.165, halfW: 0.0129, hUp: 0.028, hDown: 0.028, cy: 0.0092, power: 3.2 },
    { z: BODY_TOP, halfW: 0.0124, hUp: 0.0265, hDown: 0.0265, cy: CURVE, power: 3.2 },
  ]);
  const body = new Mesh(
    surface.build(sampleRange(BODY_BOTTOM, BODY_TOP, 16), 16, true),
    materials.polymer,
  );
  body.name = 'Body';
  body.rotation.x = -Math.PI / 2;
  root.add(body);

  // Witness holes count rounds down the near flat, following the curve.
  for (let i = 0; i < 5; i += 1) {
    const y = 0.042 + i * 0.032;
    for (const side of [-1, 1]) {
      addMesh(
        root,
        new CylinderGeometry(0.0021, 0.0021, 0.0012, 8),
        materials.steel,
        [side * 0.0137, y, -curveAt(y) + 0.004],
      ).rotation.z = Math.PI / 2;
    }
  }

  // Paint band: a slightly proud ring near the baseplate.
  addMesh(
    root,
    bevelBox(0.0292, 0.006, 0.0625, 0.0008),
    materials.paint,
    [0, BASEPLATE_HEIGHT + 0.004, -0.001],
  ).name = 'PaintBand';

  // Magazine catch notch on the front strap, just under the feed lips.
  addMesh(
    root,
    bevelBox(0.013, 0.007, 0.003, 0.0006),
    materials.steel,
    [0, BODY_TOP - 0.016, -CURVE - 0.0268],
  ).name = 'CatchNotch';

  // Spine stiffener: three short ribs rather than one straight bar, so they
  // stay seated on the curved rear face.
  for (let i = 0; i < 3; i += 1) {
    const y = 0.045 + i * 0.04;
    addMesh(
      root,
      bevelBox(0.0216, 0.0075, 0.002, 0.0005),
      materials.gunmetal,
      [0, y, 0.0295 - curveAt(y) - 0.0005],
    ).name = 'SpineRib';
  }

  // Feed lips.
  for (const side of [-1, 1]) {
    addMesh(
      root,
      bevelBox(0.0085, 0.009, 0.043, 0.0008),
      materials.steel,
      [side * 0.0072, BODY_TOP + 0.001, -CURVE - 0.0015],
    ).name = 'FeedLip';
  }

  // The top round sits in the lips; hiding this group reads as an empty mag.
  const rounds = new Group();
  rounds.name = 'Rounds';
  root.add(rounds);

  addMesh(
    rounds,
    new CylinderGeometry(0.0052, 0.0052, 0.025, 14),
    materials.brass,
    [0, BODY_TOP - 0.002, -CURVE - 0.002],
  ).rotation.x = Math.PI / 2;

  addMesh(
    rounds,
    new CylinderGeometry(0.0038, 0.005, 0.006, 14),
    materials.brass,
    [0, BODY_TOP - 0.002, -CURVE - 0.017],
  ).rotation.x = Math.PI / 2;

  // Same reasoning as the pistol magazine: a real 30-round stick is a small
  // target, so an invisible box widens the near-grab volume. It stays visible
  // (the grab pointer filters on that) and never writes colour or depth.
  const grabProxy = addMesh(
    root,
    new BoxGeometry(0.115, 0.24, 0.115),
    materials.grab,
    [0, 0.105, 0],
  );
  grabProxy.name = 'GrabProxy';
  grabProxy.userData.iwsdkPreviewBounds = 'exclude';

  return root;
}
