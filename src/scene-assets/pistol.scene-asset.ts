/**
 * DTP Shoot — grab-and-fire pistol.
 *
 * Local frame: origin sits at the top of the grip (the web of the hand), +Y is
 * up, -Z is the muzzle direction. Size envelope is roughly 0.20 x 0.14 x 0.035 m,
 * so the model reads at arm's length. `Recoil`, `Muzzle`, `MuzzleFlash`,
 * `Tracer`, `Slide`, `MagWell`, `MagEject` and `RackZone` are named runtime
 * hooks for the shooting and reload systems; the flash and tracer are hidden by
 * default and excluded from preview framing.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Path,
  Shape,
  SphereGeometry,
} from '@iwsdk/core';
import type { BufferGeometry, Material, Object3D } from '@iwsdk/core';
import { bevelBox } from './lib/hardsurface.js';

const MUZZLE_Y = 0.042;
const MUZZLE_Z = -0.166;

function createMaterials() {
  return {
    gunmetal: new MeshStandardMaterial({
      color: 0x343a42,
      metalness: 0.72,
      roughness: 0.44,
    }),
    polymer: new MeshStandardMaterial({
      color: 0x1d2024,
      metalness: 0.06,
      roughness: 0.74,
    }),
    steel: new MeshStandardMaterial({
      color: 0x7d848d,
      metalness: 0.9,
      roughness: 0.32,
    }),
    sight: new MeshStandardMaterial({
      color: 0xffb066,
      emissive: 0xff6a1a,
      emissiveIntensity: 2.2,
      roughness: 0.45,
    }),
    flash: new MeshBasicMaterial({
      color: 0xffe8b8,
      transparent: true,
      opacity: 0.92,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
    // Invisible, but still raycast: this is the rack zone, not a visual.
    marker: new MeshStandardMaterial({
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

function addBevelBox(
  parent: Object3D,
  size: [number, number, number],
  position: [number, number, number],
  material: Material,
  bevel = 0.0016,
): Mesh {
  // Bevels wider than a thin part's cross-section collapse into degenerate
  // triangles, so hairline plates and serrations use a plain box.
  const thickness = Math.min(size[0], size[1], size[2]);
  const geometry =
    thickness <= bevel * 4
      ? new BoxGeometry(size[0], size[1], size[2])
      : bevelBox(size[0], size[1], size[2], bevel);
  return addMesh(parent, geometry, material, position);
}

function roundedRect(
  width: number,
  height: number,
  radius: number,
): Shape {
  const shape = new Shape();
  const x = -width / 2;
  const y = -height / 2;
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

/** Side profile of the grip, extruded across the pistol's width. */
function buildGrip(materials: ReturnType<typeof createMaterials>): Group {
  const group = new Group();
  group.name = 'Grip';

  const profile = new Shape();
  profile.moveTo(0.032, 0.004);
  profile.quadraticCurveTo(0.036, -0.012, 0.036, -0.036);
  profile.quadraticCurveTo(0.034, -0.072, 0.026, -0.094);
  profile.lineTo(0.012, -0.1);
  profile.lineTo(-0.013, -0.1);
  profile.quadraticCurveTo(-0.024, -0.084, -0.027, -0.05);
  profile.lineTo(-0.027, -0.018);
  profile.quadraticCurveTo(-0.026, -0.004, -0.018, 0.004);
  profile.closePath();

  const width = 0.031;
  const body = new Mesh(
    new ExtrudeGeometry(profile, {
      depth: width,
      bevelEnabled: true,
      bevelSize: 0.0018,
      bevelThickness: 0.0018,
      bevelSegments: 2,
      curveSegments: 6,
      steps: 1,
    }),
    materials.polymer,
  );
  body.name = 'GripBody';
  body.rotation.y = Math.PI / 2;
  body.position.x = -width / 2;
  group.add(body);

  // Textured side panels: slightly proud, darker, split by a stipple groove.
  for (const side of [-1, 1]) {
    const panel = addBevelBox(
      group,
      [0.0022, 0.062, 0.03],
      [side * (width / 2 - 0.0004), -0.05, 0.004],
      materials.polymer,
      0.0008,
    );
    panel.name = side < 0 ? 'GripPanelLeft' : 'GripPanelRight';
  }

  addBevelBox(
    group,
    [0.034, 0.009, 0.034],
    [0, -0.104, 0.006],
    materials.gunmetal,
    0.0014,
  ).name = 'MagazineFloorplate';

  return group;
}

function buildTriggerGuard(materials: ReturnType<typeof createMaterials>): Group {
  const group = new Group();
  group.name = 'TriggerGuard';

  const outer = roundedRect(0.05, 0.048, 0.017);
  const inner = roundedRect(0.034, 0.031, 0.01);
  outer.holes.push(inner as unknown as Path);

  const depth = 0.014;
  const guard = new Mesh(
    new ExtrudeGeometry(outer, {
      depth,
      bevelEnabled: true,
      bevelSize: 0.0012,
      bevelThickness: 0.0012,
      bevelSegments: 2,
      curveSegments: 8,
      steps: 1,
    }),
    materials.polymer,
  );
  guard.name = 'Guard';
  guard.rotation.y = Math.PI / 2;
  guard.position.set(-depth / 2, -0.008, -0.062);
  group.add(guard);

  const trigger = addBevelBox(
    group,
    [0.005, 0.019, 0.005],
    [0, -0.022, -0.056],
    materials.steel,
    0.0012,
  );
  trigger.name = 'Trigger';
  trigger.rotation.x = 0.28;

  return group;
}

export function createPistol(): Object3D {
  const materials = createMaterials();

  const root = new Group();
  root.name = 'Pistol';

  const aimFrame = new Group();
  aimFrame.name = 'Recoil';
  root.add(aimFrame);

  const gripPoint = new Group();
  gripPoint.name = 'GripPoint';
  gripPoint.position.set(0, -0.045, 0.003);
  root.add(gripPoint);

  const slide = new Group();
  slide.name = 'Slide';
  aimFrame.add(slide);

  // Slide: full-length top end, chamfered, with a rear cocking serration band.
  addBevelBox(
    slide,
    [0.03, 0.036, 0.182],
    [0, 0.046, -0.048],
    materials.gunmetal,
    0.0026,
  ).name = 'SlideBody';

  addBevelBox(
    slide,
    [0.0315, 0.006, 0.176],
    [0, 0.0295, -0.048],
    materials.polymer,
    0.0012,
  ).name = 'SlideRail';

  for (let i = 0; i < 6; i += 1) {
    const z = 0.014 - i * 0.006;
    for (const side of [-1, 1]) {
      addBevelBox(
        slide,
        [0.0012, 0.026, 0.0028],
        [side * 0.0151, 0.046, z],
        materials.polymer,
        0.0005,
      );
    }
  }

  // Sights: blacked-out rear notch with two fibre dots, front post with one dot.
  for (const side of [-1, 1]) {
    addBevelBox(
      slide,
      [0.009, 0.007, 0.007],
      [side * 0.008, 0.0675, 0.0325],
      materials.gunmetal,
      0.0008,
    );
    addMesh(
      slide,
      new SphereGeometry(0.0014, 8, 6),
      materials.sight,
      [side * 0.008, 0.0665, 0.0285],
    );
  }

  const frontSight = addBevelBox(
    slide,
    [0.004, 0.0075, 0.008],
    [0, 0.0675, -0.128],
    materials.gunmetal,
    0.0008,
  );
  frontSight.name = 'FrontSight';
  addMesh(
    slide,
    new SphereGeometry(0.0015, 8, 6),
    materials.sight,
    [0, 0.0672, -0.132],
  );

  const frame = new Group();
  frame.name = 'Frame';
  aimFrame.add(frame);

  addBevelBox(
    frame,
    [0.028, 0.019, 0.166],
    [0, 0.0175, -0.04],
    materials.polymer,
    0.0022,
  ).name = 'FrameBody';

  addBevelBox(
    frame,
    [0.026, 0.009, 0.072],
    [0, 0.0115, -0.094],
    materials.polymer,
    0.0016,
  ).name = 'DustCover';

  addMesh(
    frame,
    new CylinderGeometry(0.0092, 0.0092, 0.018, 20),
    materials.steel,
    [0, MUZZLE_Y, -0.142],
  ).rotation.x = Math.PI / 2;

  addMesh(
    frame,
    new CircleGeometry(0.0068, 20),
    materials.polymer,
    [0, MUZZLE_Y, -0.1512],
  ).name = 'Bore';

  aimFrame.add(buildGrip(materials));
  aimFrame.add(buildTriggerGuard(materials));

  // Control furniture.
  addBevelBox(
    frame,
    [0.004, 0.005, 0.024],
    [0.0155, 0.026, 0.008],
    materials.steel,
    0.0008,
  ).name = 'SlideStop';

  addBevelBox(
    frame,
    [0.0035, 0.004, 0.012],
    [-0.0155, 0.012, 0.018],
    materials.steel,
    0.0008,
  ).name = 'MagazineRelease';

  // Marks the muzzle so the shooting system never hard-codes the barrel tip.
  const muzzle = new Group();
  muzzle.name = 'Muzzle';
  muzzle.position.set(0, MUZZLE_Y, MUZZLE_Z);
  aimFrame.add(muzzle);

  // Reload markers. `MagWell` is where a seated magazine's origin belongs (the
  // insert test), `MagEject` is where an ejected magazine appears (the drop).
  // Both are empty groups, so they never affect bounds.
  const magWell = new Group();
  magWell.name = 'MagWell';
  magWell.position.set(0, -0.06, 0);
  aimFrame.add(magWell);

  const magEject = new Group();
  magEject.name = 'MagEject';
  magEject.position.set(0, -0.1, 0.006);
  aimFrame.add(magEject);

  // Invisible box the free hand must be inside to rack the slide.
  const rackZone = addMesh(
    aimFrame,
    new BoxGeometry(0.26, 0.15, 0.42),
    materials.marker,
    [0, 0.055, -0.01],
  );
  rackZone.name = 'RackZone';
  rackZone.userData.iwsdkPreviewBounds = 'exclude';

  const flash = new Group();
  flash.name = 'MuzzleFlash';
  flash.visible = false;
  muzzle.add(flash);

  const flashCone = addMesh(
    flash,
    new ConeGeometry(0.026, 0.07, 10, 1, true),
    materials.flash,
    [0, 0, -0.03],
  );
  flashCone.rotation.x = -Math.PI / 2;
  addMesh(flash, new SphereGeometry(0.017, 10, 8), materials.flash, [0, 0, 0]);

  // The tracer hangs off the pistol root, not the aim frame: the old kick effect rotated
  // the barrel for a few frames, and a line that inherits that kick visibly
  // flicks upward. The shooting system places it along the actual shot ray.
  const tracer = addMesh(
    root,
    new BoxGeometry(0.0028, 0.0028, 3),
    materials.flash,
    [0, MUZZLE_Y, MUZZLE_Z - 1.48],
  );
  tracer.name = 'Tracer';
  tracer.visible = false;

  // Effects must not inflate placement bounds or the preview camera fit.
  flash.userData.iwsdkPreviewBounds = 'exclude';
  tracer.userData.iwsdkPreviewBounds = 'exclude';

  return root;
}
