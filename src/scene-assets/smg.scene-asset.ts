/**
 * DTP Shoot — grab-and-fire SMG.
 *
 * Local frame matches the pistol so the same grab, aim and reload code drives
 * both: the origin sits at the top of the grip (the web of the hand), +Y is up
 * and -Z is the muzzle direction. The envelope is roughly 0.055 x 0.2 x 0.58 m,
 * which suits a shoulder-fired PDW at arm's length.
 *
 * Named runtime hooks:
 *   Recoil      group that kicks on each shot
 *   Slide       bolt + charging handle; rack and lock-back travel on this group
 *   Muzzle      barrel tip, carries the corrected firing direction
 *   MuzzleFlash / Tracer   hidden effects, excluded from preview framing
 *   MagWell     where a seated magazine's origin belongs, for the insert test
 *   MagEject    where an ejected magazine appears
 *   RackZone    invisible box the free hand must be inside to rack the bolt
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
  Shape,
  SphereGeometry,
} from '@iwsdk/core';
import type { BufferGeometry, Material, Object3D } from '@iwsdk/core';
import { bevelBox, LoftSurface, sampleRange } from './lib/hardsurface.js';

const MUZZLE_Y = 0.04;
const MUZZLE_Z = -0.372;
const MAG_WELL_Z = -0.086;
const MAG_WELL_Y = -0.228;
const TRACER_UNIT = 3;

function createMaterials() {
  return {
    gunmetal: new MeshStandardMaterial({
      color: 0x333a42,
      metalness: 0.74,
      roughness: 0.42,
    }),
    polymer: new MeshStandardMaterial({
      color: 0x1f2328,
      metalness: 0.05,
      roughness: 0.76,
    }),
    steel: new MeshStandardMaterial({
      color: 0x7d848d,
      metalness: 0.9,
      roughness: 0.3,
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
  const thickness = Math.min(size[0], size[1], size[2]);
  const geometry =
    thickness <= bevel * 4
      ? new BoxGeometry(size[0], size[1], size[2])
      : bevelBox(size[0], size[1], size[2], bevel);
  return addMesh(parent, geometry, material, position);
}

function roundedRect(width: number, height: number, radius: number): Shape {
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

export function createSmg(): Object3D {
  const materials = createMaterials();

  const root = new Group();
  root.name = 'SMG';

  const recoil = new Group();
  recoil.name = 'Recoil';
  root.add(recoil);

  const gripPoint = new Group();
  gripPoint.name = 'GripPoint';
  gripPoint.position.set(0, -0.045, 0.05);
  root.add(gripPoint);

  const supportGrip = new Group();
  supportGrip.name = 'SupportGrip';
  supportGrip.position.set(0, 0.04, -0.245);
  root.add(supportGrip);
  const body = new Group();
  body.name = 'Body';
  recoil.add(body);

  // --- receiver ---
  const receiverSurface = LoftSurface.tube([
    { z: -0.208, halfW: 0.0215, hUp: 0.021, hDown: 0.019, cy: 0.039, power: 3.4 },
    { z: -0.15, halfW: 0.0245, hUp: 0.026, hDown: 0.025, cy: 0.04, power: 3.8 },
    { z: -0.06, halfW: 0.0258, hUp: 0.0285, hDown: 0.027, cy: 0.04, power: 4 },
    { z: 0.058, halfW: 0.0258, hUp: 0.0285, hDown: 0.027, cy: 0.04, power: 4 },
    { z: 0.136, halfW: 0.0235, hUp: 0.0245, hDown: 0.023, cy: 0.039, power: 3.5 },
  ]);
  addMesh(
    body,
    receiverSurface.build(sampleRange(-0.208, 0.136, 20), 22, true),
    materials.gunmetal,
    [0, 0, 0],
  ).name = 'Receiver';

  // Rear cap and the seam that separates upper from lower.
  addBevelBox(
    body,
    [0.046, 0.05, 0.008],
    [0, 0.038, 0.14],
    materials.polymer,
    0.003,
  ).name = 'ReceiverCap';

  addBevelBox(
    body,
    [0.0505, 0.004, 0.28],
    [0, 0.0165, -0.02],
    materials.polymer,
    0.0012,
  ).name = 'ReceiverSeam';

  // --- top rail ---
  const rail = new Group();
  rail.name = 'TopRail';
  body.add(rail);
  addBevelBox(
    rail,
    [0.03, 0.007, 0.25],
    [0, 0.0745, -0.02],
    materials.gunmetal,
    0.0014,
  ).name = 'RailBase';
  for (let i = 0; i < 9; i += 1) {
    addBevelBox(
      rail,
      [0.032, 0.005, 0.006],
      [0, 0.0805, 0.086 - i * 0.026],
      materials.gunmetal,
      0.0008,
    ).name = 'RailRib';
  }

  // --- handguard around the barrel ---
  const handguard = new Group();
  handguard.name = 'Handguard';
  body.add(handguard);
  const shroudSurface = LoftSurface.tube([
    { z: -0.312, halfW: 0.0215, hUp: 0.023, hDown: 0.026, cy: 0.039, power: 3.2 },
    { z: -0.24, halfW: 0.0255, hUp: 0.026, hDown: 0.03, cy: 0.04, power: 3.2 },
    { z: -0.17, halfW: 0.0265, hUp: 0.027, hDown: 0.031, cy: 0.04, power: 3.2 },
  ]);
  addMesh(
    handguard,
    shroudSurface.build(sampleRange(-0.312, -0.17, 10), 18, true),
    materials.polymer,
    [0, 0, 0],
  ).name = 'Shroud';

  for (let i = 0; i < 5; i += 1) {
    const z = -0.29 + i * 0.026;
    for (const side of [-1, 1]) {
      addBevelBox(
        handguard,
        [0.004, 0.012, 0.014],
        [side * 0.0252, 0.043, z],
        materials.gunmetal,
        0.0008,
      ).name = 'Vent';
    }
  }

  // Short lower rail under the handguard, where a support hand would sit.
  for (let i = 0; i < 4; i += 1) {
    addBevelBox(
      handguard,
      [0.022, 0.006, 0.005],
      [0, 0.0075, -0.29 + i * 0.026],
      materials.gunmetal,
      0.0008,
    ).name = 'LowerRailRib';
  }
  addBevelBox(
    handguard,
    [0.024, 0.006, 0.115],
    [0, 0.011, -0.245],
    materials.gunmetal,
    0.0012,
  ).name = 'LowerRailBase';

  // Visible vertical foregrip for the support hand. The runtime SupportGrip
  // anchor remains on the stable weapon root; this is visual geometry only.
  const foregrip = new Group();
  foregrip.name = 'VerticalForegrip';
  handguard.add(foregrip);
  addBevelBox(
    foregrip,
    [0.042, 0.13, 0.046],
    [0, -0.057, -0.245],
    materials.polymer,
    0.004,
  ).name = 'ForegripBody';
  addBevelBox(
    foregrip,
    [0.048, 0.012, 0.054],
    [0, 0.008, -0.245],
    materials.gunmetal,
    0.002,
  ).name = 'ForegripCollar';
  for (let i = 0; i < 4; i += 1) {
    addBevelBox(
      foregrip,
      [0.044, 0.004, 0.05],
      [0, -0.018 - i * 0.023, -0.245],
      materials.gunmetal,
      0.001,
    ).name = 'ForegripRib';
  }

  // --- barrel and muzzle device ---
  addMesh(
    body,
    new CylinderGeometry(0.0095, 0.0095, 0.17, 20),
    materials.steel,
    [0, MUZZLE_Y, -0.29],
  ).rotation.x = Math.PI / 2;

  addMesh(
    body,
    new CylinderGeometry(0.0145, 0.0135, 0.05, 18),
    materials.gunmetal,
    [0, MUZZLE_Y, -0.35],
  ).rotation.x = Math.PI / 2;

  for (let i = 0; i < 3; i += 1) {
    addMesh(
      body,
      new CylinderGeometry(0.0152, 0.0152, 0.003, 18),
      materials.steel,
      [0, MUZZLE_Y, -0.336 - i * 0.011],
    ).rotation.x = Math.PI / 2;
  }

  addMesh(
    body,
    new CircleGeometry(0.0075, 20),
    materials.polymer,
    [0, MUZZLE_Y, MUZZLE_Z + 0.0012],
  ).name = 'Bore';

  // Ports in the shroud so the barrel reads through the handguard.
  for (const side of [-1, 1]) {
    addMesh(
      body,
      new BoxGeometry(0.0016, 0.011, 0.05),
      materials.polymer,
      [side * 0.0246, 0.039, -0.24],
    ).name = 'ShroudPort';
  }

  // --- grip ---
  const grip = new Group();
  grip.name = 'Grip';
  body.add(grip);

  const gripProfile = new Shape();
  gripProfile.moveTo(0.074, 0.014);
  gripProfile.quadraticCurveTo(0.05, 0.014, 0.03, 0.012);
  gripProfile.quadraticCurveTo(0.021, -0.012, 0.023, -0.05);
  gripProfile.quadraticCurveTo(0.028, -0.086, 0.038, -0.1);
  gripProfile.lineTo(0.062, -0.104);
  gripProfile.quadraticCurveTo(0.076, -0.078, 0.079, -0.042);
  gripProfile.lineTo(0.08, -0.008);
  gripProfile.quadraticCurveTo(0.08, 0.008, 0.074, 0.014);
  gripProfile.closePath();

  const gripWidth = 0.03;
  const gripBody = new Mesh(
    new ExtrudeGeometry(gripProfile, {
      depth: gripWidth,
      bevelEnabled: true,
      bevelSize: 0.0018,
      bevelThickness: 0.0018,
      bevelSegments: 2,
      curveSegments: 6,
      steps: 1,
    }),
    materials.polymer,
  );
  gripBody.name = 'GripBody';
  gripBody.rotation.y = Math.PI / 2;
  gripBody.position.x = -gripWidth / 2;
  grip.add(gripBody);

  for (const side of [-1, 1]) {
    addBevelBox(
      grip,
      [0.0022, 0.07, 0.03],
      [side * (gripWidth / 2 - 0.0004), -0.046, 0.05],
      materials.polymer,
      0.0008,
    ).name = side < 0 ? 'GripPanelLeft' : 'GripPanelRight';
  }

  // --- trigger group ---
  const triggerGroup = new Group();
  triggerGroup.name = 'TriggerGuard';
  body.add(triggerGroup);

  const guardOuter = roundedRect(0.052, 0.05, 0.017);
  const guardInner = roundedRect(0.034, 0.032, 0.01);
  guardOuter.holes.push(guardInner as unknown as Shape);
  const guard = new Mesh(
    new ExtrudeGeometry(guardOuter, {
      depth: 0.015,
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
  guard.position.set(-0.0075, -0.014, -0.026);
  triggerGroup.add(guard);

  const trigger = addBevelBox(
    triggerGroup,
    [0.005, 0.021, 0.006],
    [0, -0.028, -0.03],
    materials.steel,
    0.0012,
  );
  trigger.name = 'Trigger';
  trigger.rotation.x = 0.3;

  // Lower receiver bridge closes the open gap between the trigger housing and
  // the front of the rear grip without interfering with the trigger opening.
  addBevelBox(
    body,
    [0.042, 0.034, 0.058],
    [0, 0.004, 0.028],
    materials.polymer,
    0.004,
  ).name = 'LowerReceiverBridge';

  // --- magazine well ---
  const magWell = new Group();
  magWell.name = 'MagWell';
  magWell.position.set(0, MAG_WELL_Y, MAG_WELL_Z);
  body.add(magWell);

  addBevelBox(
    body,
    [0.032, 0.062, 0.062],
    [0, -0.032, MAG_WELL_Z],
    materials.gunmetal,
    0.003,
  ).name = 'MagWellHousing';

  addBevelBox(
    body,
    [0.026, 0.008, 0.052],
    [0, -0.061, MAG_WELL_Z],
    materials.polymer,
    0.0012,
  ).name = 'MagWellMouth';

  for (const side of [-1, 1]) {
    addBevelBox(
      body,
      [0.004, 0.03, 0.012],
      [side * 0.0164, -0.03, MAG_WELL_Z + 0.024],
      materials.polymer,
      0.0008,
    ).name = 'MagWellGripRidge';
  }

  // --- stock ---
  const stock = new Group();
  stock.name = 'Stock';
  body.add(stock);
  for (const side of [-1, 1]) {
    addMesh(
      stock,
      new CylinderGeometry(0.0062, 0.0062, 0.085, 12),
      materials.steel,
      [side * 0.017, 0.047, 0.18],
    ).rotation.x = Math.PI / 2;
  }
  addBevelBox(
    stock,
    [0.05, 0.072, 0.014],
    [0, 0.04, 0.224],
    materials.polymer,
    0.004,
  ).name = 'ButtPlate';
  addBevelBox(
    stock,
    [0.012, 0.014, 0.075],
    [0, 0.008, 0.185],
    materials.steel,
    0.002,
  ).name = 'StockBrace';
  addBevelBox(
    stock,
    [0.046, 0.01, 0.03],
    [0, 0.068, 0.152],
    materials.gunmetal,
    0.002,
  ).name = 'StockHinge';

  // --- sights ---
  const sights = new Group();
  sights.name = 'Sights';
  body.add(sights);

  // Rear drum: the aperture cylinder lies across the bore.
  addMesh(
    sights,
    new CylinderGeometry(0.0115, 0.0115, 0.026, 18),
    materials.gunmetal,
    [0, 0.086, 0.064],
  ).rotation.z = Math.PI / 2;
  addMesh(
    sights,
    new CircleGeometry(0.0038, 12),
    materials.polymer,
    [0.0131, 0.086, 0.064],
  ).rotation.y = Math.PI / 2;

  for (const side of [-1, 1]) {
    addBevelBox(
      sights,
      [0.004, 0.026, 0.007],
      [side * 0.0085, 0.092, -0.296],
      materials.gunmetal,
      0.0008,
    ).name = 'FrontSightHood';
  }
  addBevelBox(
    sights,
    [0.003, 0.017, 0.005],
    [0, 0.086, -0.296],
    materials.steel,
    0.0006,
  ).name = 'FrontSightPost';
  addMesh(
    sights,
    new SphereGeometry(0.0016, 8, 6),
    materials.sight,
    [0, 0.086, -0.2985],
  ).name = 'FrontSightDot';
  addMesh(
    sights,
    new SphereGeometry(0.0016, 8, 6),
    materials.sight,
    [-0.0134, 0.086, 0.064],
  ).name = 'RearSightDot';

  // --- controls and ports ---
  addBevelBox(
    body,
    [0.004, 0.006, 0.02],
    [0.0264, 0.026, 0.05],
    materials.steel,
    0.0008,
  ).name = 'FireSelector';

  addBevelBox(
    body,
    [0.005, 0.012, 0.012],
    [0.026, -0.012, 0.0],
    materials.steel,
    0.0008,
  ).name = 'MagazineRelease';

  addBevelBox(
    body,
    [0.0018, 0.019, 0.062],
    [0.0259, 0.046, 0.012],
    materials.polymer,
    0.0006,
  ).name = 'EjectionPort';

  addBevelBox(
    body,
    [0.0022, 0.006, 0.05],
    [0.0262, 0.033, 0.012],
    materials.steel,
    0.0006,
  ).name = 'EjectionPortLedge';

  // --- bolt and charging handle (the "slide" the rack gesture moves) ---
  const slide = new Group();
  slide.name = 'Slide';
  recoil.add(slide);

  addBevelBox(
    slide,
    [0.02, 0.014, 0.08],
    [0, 0.046, 0.048],
    materials.steel,
    0.002,
  ).name = 'BoltCarrier';

  addMesh(
    slide,
    new CylinderGeometry(0.0055, 0.0055, 0.032, 12),
    materials.steel,
    [-0.038, 0.062, 0.062],
  ).rotation.z = Math.PI / 2;

  addMesh(
    slide,
    new CylinderGeometry(0.0105, 0.0105, 0.014, 14),
    materials.gunmetal,
    [-0.055, 0.062, 0.062],
  ).rotation.z = Math.PI / 2;

  // --- reload markers ---
  const eject = new Group();
  eject.name = 'MagEject';
  eject.position.set(0, -0.07, MAG_WELL_Z);
  body.add(eject);

  // Invisible box the free hand must be inside to rack the bolt, sized to the
  // rear receiver top where the charging handle sits.
  const rackZone = addMesh(
    recoil,
    new BoxGeometry(0.16, 0.13, 0.3),
    materials.marker,
    [-0.008, 0.05, 0.055],
  );
  rackZone.name = 'RackZone';
  rackZone.userData.iwsdkPreviewBounds = 'exclude';

  // --- muzzle and effects ---
  const muzzle = new Group();
  muzzle.name = 'Muzzle';
  muzzle.position.set(0, MUZZLE_Y, MUZZLE_Z);
  recoil.add(muzzle);

  const flash = new Group();
  flash.name = 'MuzzleFlash';
  flash.visible = false;
  muzzle.add(flash);

  const flashCone = addMesh(
    flash,
    new ConeGeometry(0.03, 0.085, 10, 1, true),
    materials.flash,
    [0, 0, -0.036],
  );
  flashCone.rotation.x = -Math.PI / 2;
  addMesh(flash, new SphereGeometry(0.019, 10, 8), materials.flash, [0, 0, 0]);

  // The tracer hangs off the weapon root, not the recoil group, so the shot
  // line never inherits the upward kick.
  const tracer = addMesh(
    root,
    new BoxGeometry(0.0028, 0.0028, TRACER_UNIT),
    materials.flash,
    [0, MUZZLE_Y, MUZZLE_Z - 1.48],
  );
  tracer.name = 'Tracer';
  tracer.visible = false;

  flash.userData.iwsdkPreviewBounds = 'exclude';
  tracer.userData.iwsdkPreviewBounds = 'exclude';

  return root;
}
