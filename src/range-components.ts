/**
 * DTP Shoot — component declarations.
 *
 * System-free module: no World, DOM or renderer imports live here, because the
 * editor imports this module to build its inspector.
 */

import { createComponent, Types } from '@iwsdk/core';

export const TargetState = {
  Down: 'Down',
  Rising: 'Rising',
  Up: 'Up',
  Hit: 'Hit',
} as const;

/** Bench-selectable ammo behaviour. */
export const AmmoMode = {
  Unlimited: 'Unlimited',
  Reloading: 'Reloading',
} as const;

/** The two weapons the bench can load. Each owns its gun, magazines and mag well. */
export const WeaponKind = {
  Pistol: 'Pistol',
  SMG: 'SMG',
} as const;

export type WeaponKindValue = (typeof WeaponKind)[keyof typeof WeaponKind];

/**
 * Per-weapon magazine bounds. The bench counter edits the active weapon's size
 * and every weapon remembers its own, so switching back restores it.
 */
export const WEAPON_MAGAZINE = {
  [WeaponKind.Pistol]: { min: 1, max: 12, size: 8 },
  [WeaponKind.SMG]: { min: 10, max: 40, size: 30 },
} as const;

/** Widest bound any weapon allows, used for the shared editor field range. */
export const MAGAZINE_MAX = 40;

/** A pop-up scoring plate. */
export const Target = createComponent('Target', {
  points: { type: Types.Int32, default: 100, min: 10, step: 10 },
  slot: { type: Types.Int32, default: 0 },
  state: {
    type: Types.Enum,
    default: TargetState.Down,
    enum: TargetState,
    label: 'State',
  },
  timer: { type: Types.Float32, default: 0, label: 'State timer' },
  angle: { type: Types.Float32, default: -1.45, label: 'Arm angle' },
});

/** A grabbable weapon and its per-shot timers. */
export const Gun = createComponent('Gun', {
  kind: {
    type: Types.Enum,
    default: WeaponKind.Pistol,
    enum: WeaponKind,
    label: 'Weapon',
  },
  automatic: { type: Types.Boolean, default: false, label: 'Full auto' },
  twoHanded: { type: Types.Boolean, default: false, label: 'Two-hand control' },
  fireInterval: { type: Types.Float32, default: 0.16, min: 0.05, step: 0.01 },
  cooldown: { type: Types.Float32, default: 0 },
  flashTime: { type: Types.Float32, default: 0 },
  tracerTime: { type: Types.Float32, default: 0 },
  ammo: { type: Types.Int32, default: 8, min: 0, step: 1 },
  magazineSize: { type: Types.Int32, default: 8, min: 1, step: 1 },
  magIn: { type: Types.Boolean, default: true, label: 'Magazine seated' },
  needsRack: { type: Types.Boolean, default: false, label: 'Slide locked back' },
  rackPull: { type: Types.Float32, default: 0, label: 'Slide pull (m)' },
  slideTravel: {
    type: Types.Float32,
    default: 0.02,
    min: 0,
    step: 0.005,
    label: 'Slide lock-back (m)',
  },
});

/** A spare magazine resting on the bench. */
export const Magazine = createComponent('Magazine', {
  kind: {
    type: Types.Enum,
    default: WeaponKind.Pistol,
    enum: WeaponKind,
    label: 'Fits',
  },
  rounds: { type: Types.Int32, default: 8, min: 0, step: 1 },
  ready: { type: Types.Boolean, default: true },
  respawn: { type: Types.Float32, default: 0, label: 'Respawn timer' },
});

/** Singleton round state, rendered by the range HUD. */
export const RangeGame = createComponent('RangeGame', {
  score: { type: Types.Int32, default: 0 },
  timeLeft: { type: Types.Float32, default: 60 },
  roundSeconds: { type: Types.Float32, default: 60, min: 10, step: 5 },
  running: { type: Types.Boolean, default: false },
  finished: { type: Types.Boolean, default: false },
  shots: { type: Types.Int32, default: 0 },
  hits: { type: Types.Int32, default: 0 },
  lastHitPoints: { type: Types.Int32, default: 0 },
  hitPulse: { type: Types.Float32, default: 0 },
  restartRequested: { type: Types.Boolean, default: false },
  status: { type: Types.String, default: 'Grab the pistol and pull the trigger' },
  ammoMode: {
    type: Types.Enum,
    default: AmmoMode.Reloading,
    enum: AmmoMode,
    label: 'Ammo mode',
  },
  weapon: {
    type: Types.Enum,
    default: WeaponKind.Pistol,
    enum: WeaponKind,
    label: 'Weapon',
  },
  /** Live magazine size of the active weapon. */
  magazineSize: {
    type: Types.Int32,
    default: 8,
    min: 1,
    max: MAGAZINE_MAX,
    step: 1,
    label: 'Magazine size',
  },
  /** Remembered per-weapon sizes, restored when that weapon is selected. */
  pistolMagazineSize: {
    type: Types.Int32,
    default: 8,
    min: 1,
    max: 12,
    step: 1,
    label: 'Pistol magazine size',
  },
  smgMagazineSize: {
    type: Types.Int32,
    default: 30,
    min: 10,
    max: 40,
    step: 1,
    label: 'SMG magazine size',
  },
  /** Persistent vertical offset applied to the authored XR experience. */
  heightOffset: {
    type: Types.Float32,
    default: 0,
    min: -0.5,
    max: 0.5,
    step: 0.05,
    label: 'Experience height offset',
  },
});
