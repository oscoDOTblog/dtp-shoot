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

/** The grabbable pistol and its per-shot timers. */
export const Gun = createComponent('Gun', {
  fireInterval: { type: Types.Float32, default: 0.16, min: 0.05, step: 0.01 },
  cooldown: { type: Types.Float32, default: 0 },
  recoil: { type: Types.Float32, default: 0 },
  flashTime: { type: Types.Float32, default: 0 },
  tracerTime: { type: Types.Float32, default: 0 },
  ammo: { type: Types.Int32, default: 6, min: 0, step: 1 },
  magazineSize: { type: Types.Int32, default: 6, min: 1, step: 1 },
  magIn: { type: Types.Boolean, default: true, label: 'Magazine seated' },
  needsRack: { type: Types.Boolean, default: false, label: 'Slide locked back' },
  rackPull: { type: Types.Float32, default: 0, label: 'Slide pull (m)' },
});

/** A spare magazine resting on the bench. */
export const Magazine = createComponent('Magazine', {
  rounds: { type: Types.Int32, default: 6, min: 0, step: 1 },
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
});
