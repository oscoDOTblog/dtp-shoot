/**
 * DTP Shoot — target range loop.
 *
 * Owns the round timer, pop-up targets, hitscan, scoring and gun feedback.
 * All per-frame work reuses preallocated vectors, so `update` does not allocate.
 */

import {
  AudioListener,
  AudioSource,
  Grabbed,
  GrabSystem,
  InputComponent,
  Quaternion,
  Raycaster,
  Vector3,
  createSystem,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import { Gun, RangeGame, Target, TargetState } from './range-components.js';

const DOWN_ANGLE = -1.45;
const RISE_RATE = 8.5;
const FALL_RATE = 12;
const UP_SECONDS = 2.8;
const RESPAWN_DELAY = 0.5;
const ACTIVE_TARGETS = 2;
const SPAWN_INTERVAL = 0.4;
const MAX_SHOT_DISTANCE = 40;
const MAX_TRACER_LENGTH = 12;
/** The pistol's tracer mesh is 3 m long before scaling. */
const TRACER_UNIT = 3;
const DEFAULT_STATUS = 'Grab the pistol and pull the trigger';
const FINISHED_STATUS = 'Round over. Pull the trigger to go again';

type TargetRuntime = { arm: Object3D | null; head: Object3D | null };
type GunRuntime = {
  recoil: Object3D | null;
  muzzle: Object3D | null;
  flash: Object3D | null;
  tracer: Object3D | null;
  correction: Quaternion;
};

export class RangeGameSystem extends createSystem({
  game: { required: [RangeGame] },
  targets: { required: [Target] },
  guns: { required: [Gun] },
  heldGuns: { required: [Gun, Grabbed] },
}) {
  private readonly targetRuntime = new Map<number, TargetRuntime>();
  private readonly gunRuntime = new Map<number, GunRuntime>();
  private readonly raycaster = new Raycaster();
  private readonly shotOrigin = new Vector3();
  private readonly shotDirection = new Vector3();
  private readonly shotQuaternion = new Quaternion();
  private readonly gunQuaternion = new Quaternion();
  private readonly rayQuaternion = new Quaternion();
  private readonly tracerMid = new Vector3();
  private readonly tracerParentQuaternion = new Quaternion();
  private readonly recoilTilt = new Quaternion();
  private readonly xAxis = new Vector3(1, 0, 0);
  private readonly candidates: Object3D[] = [];
  private audioContext: AudioContext | null = null;
  private spawnTimer = 0;

  init(): void {
    this.raycaster.far = MAX_SHOT_DISTANCE;
    this.bindAudioUnlock();
    this.cleanupFuncs.push(
      this.queries.heldGuns.subscribe('disqualify', (entity) => {
        this.resetGunPose(entity);
      }),
    );
  }

  update(delta: number): void {
    const game = this.gameEntity();
    if (game == null) {
      return;
    }

    if (game.getValue(RangeGame, 'restartRequested') === true) {
      game.setValue(RangeGame, 'restartRequested', false);
      this.resetRound(game);
    }

    this.updateRound(game, delta);
    this.handleShooting(game);
    this.updateTargets(game, delta);
    this.updateGunFeedback(delta);
  }

  private gameEntity(): Entity | null {
    for (const entity of this.queries.game.entities) {
      return entity;
    }
    return null;
  }

  private resetRound(game: Entity): void {
    game.setValue(RangeGame, 'score', 0);
    game.setValue(RangeGame, 'shots', 0);
    game.setValue(RangeGame, 'hits', 0);
    game.setValue(RangeGame, 'timeLeft', game.getValue(RangeGame, 'roundSeconds') ?? 60);
    game.setValue(RangeGame, 'running', false);
    game.setValue(RangeGame, 'finished', false);
    game.setValue(RangeGame, 'hitPulse', 0);
    game.setValue(RangeGame, 'lastHitPoints', 0);
    game.setValue(RangeGame, 'status', DEFAULT_STATUS);
    this.spawnTimer = 0;
    for (const target of this.queries.targets.entities) {
      target.setValue(Target, 'state', TargetState.Down);
      target.setValue(Target, 'timer', 0);
      target.setValue(Target, 'angle', DOWN_ANGLE);
    }
  }

  private updateRound(game: Entity, delta: number): void {
    if (game.getValue(RangeGame, 'running') === true) {
      const remaining = (game.getValue(RangeGame, 'timeLeft') ?? 0) - delta;
      if (remaining <= 0) {
        game.setValue(RangeGame, 'timeLeft', 0);
        game.setValue(RangeGame, 'running', false);
        game.setValue(RangeGame, 'finished', true);
        game.setValue(RangeGame, 'status', FINISHED_STATUS);
        for (const target of this.queries.targets.entities) {
          target.setValue(Target, 'state', TargetState.Down);
          target.setValue(Target, 'timer', RESPAWN_DELAY);
        }
        return;
      }
      game.setValue(RangeGame, 'timeLeft', remaining);
    }

    const pulse = (game.getValue(RangeGame, 'hitPulse') ?? 0) - delta;
    if (pulse <= 0) {
      if ((game.getValue(RangeGame, 'hitPulse') ?? 0) > 0) {
        game.setValue(RangeGame, 'hitPulse', 0);
        game.setValue(
          RangeGame,
          'status',
          game.getValue(RangeGame, 'finished') === true
            ? FINISHED_STATUS
            : game.getValue(RangeGame, 'running') === true
              ? 'Live. Keep shooting'
              : DEFAULT_STATUS,
        );
      }
    } else {
      game.setValue(RangeGame, 'hitPulse', pulse);
    }
  }

  private startRound(game: Entity): void {
    game.setValue(RangeGame, 'running', true);
    game.setValue(RangeGame, 'finished', false);
    game.setValue(RangeGame, 'score', 0);
    game.setValue(RangeGame, 'shots', 0);
    game.setValue(RangeGame, 'hits', 0);
    game.setValue(RangeGame, 'timeLeft', game.getValue(RangeGame, 'roundSeconds') ?? 60);
    game.setValue(RangeGame, 'status', 'Live. Keep shooting');
    this.spawnTimer = 0;
    for (const target of this.queries.targets.entities) {
      target.setValue(Target, 'state', TargetState.Down);
      target.setValue(Target, 'timer', 0);
    }
  }

  private handleShooting(game: Entity): void {
    const rightPad = this.input.xr.gamepads.right;
    const leftPad = this.input.xr.gamepads.left;
    const triggerDown =
      rightPad?.getButtonDown(InputComponent.Trigger) === true ||
      leftPad?.getButtonDown(InputComponent.Trigger) === true;
    const keyDown = this.input.keyboard.getKeyDown('Space');

    if (!triggerDown && !keyDown) {
      return;
    }

    const held = this.firstHeldGun();
    if (held != null && (held.getValue(Gun, 'cooldown') ?? 0) <= 0) {
      this.fireFromGun(game, held);
      return;
    }

    // Desktop affordance: with no pistol in hand, Space shoots from the view ray.
    if (keyDown && held == null) {
      this.fireFromView(game);
    }
  }

  private firstHeldGun(): Entity | null {
    for (const gun of this.queries.heldGuns.entities) {
      return gun;
    }
    return null;
  }

  private fireFromGun(game: Entity, gun: Entity): void {
    if (game.getValue(RangeGame, 'finished') === true) {
      this.resetRound(game);
      return;
    }
    if (game.getValue(RangeGame, 'running') !== true) {
      this.startRound(game);
    }

    const gunObject = gun.object3D;
    if (gunObject == null) {
      return;
    }
    const runtime = this.gunState(gun, gunObject);

    gunObject.updateWorldMatrix(true, false);
    // The muzzle carries the corrected barrel orientation, so aim through it
    // rather than through the grabbed root.
    const aim = runtime.muzzle ?? gunObject;
    aim.getWorldPosition(this.shotOrigin);
    aim.getWorldQuaternion(this.shotQuaternion);
    this.shotDirection.set(0, 0, -1).applyQuaternion(this.shotQuaternion);
    this.raycaster.set(this.shotOrigin, this.shotDirection);

    this.resolveShot(game, gun, runtime);
  }

  private readGunDirection(object: Object3D): void {
    object.getWorldQuaternion(this.shotQuaternion);
    this.shotDirection.set(0, 0, -1).applyQuaternion(this.shotQuaternion);
    this.raycaster.set(this.shotOrigin, this.shotDirection);
  }

  private fireFromView(game: Entity): void {
    if (game.getValue(RangeGame, 'finished') === true) {
      this.resetRound(game);
      return;
    }
    if (game.getValue(RangeGame, 'running') !== true) {
      this.startRound(game);
    }

    const head = this.player.head;
    head.getWorldPosition(this.shotOrigin);
    this.readGunDirection(head);
    this.resolveShot(game, null, null);
  }

  private resolveShot(game: Entity, gun: Entity | null, runtime: GunRuntime | null): void {
    const shots = game.getValue(RangeGame, 'shots') ?? 0;
    game.setValue(RangeGame, 'shots', shots + 1);

    if (gun != null && runtime != null) {
      this.playShot(gun);
      gun.setValue(Gun, 'cooldown', gun.getValue(Gun, 'fireInterval') ?? 0.16);
      gun.setValue(Gun, 'recoil', 1);
      gun.setValue(Gun, 'flashTime', 0.055);
      gun.setValue(Gun, 'tracerTime', 0.035);
      if (runtime.flash != null) {
        runtime.flash.visible = true;
      }
      if (runtime.tracer != null) {
        runtime.tracer.visible = true;
      }
    }

    this.candidates.length = 0;
    for (const target of this.queries.targets.entities) {
      if (target.getValue(Target, 'state') !== TargetState.Up) {
        continue;
      }
      const state = this.targetState(target);
      if (state.head == null || target.object3D == null) {
        continue;
      }
      state.head.updateWorldMatrix(true, false);
      this.candidates.push(state.head);
    }

    let distance = MAX_SHOT_DISTANCE;
    let hitEntity: Entity | null = null;
    if (this.candidates.length > 0) {
      const hits = this.raycaster.intersectObjects(this.candidates, true);
      if (hits.length > 0) {
        distance = hits[0].distance;
        hitEntity = this.entityForHead(this.rootHead(hits[0].object));
      }
    }

    if (gun != null && runtime != null) {
      this.placeTracer(gun, runtime, distance);
    }

    if (hitEntity == null) {
      return;
    }

    const points = hitEntity.getValue(Target, 'points') ?? 100;
    hitEntity.setValue(Target, 'state', TargetState.Hit);
    hitEntity.setValue(Target, 'timer', 0);
    game.setValue(RangeGame, 'hits', (game.getValue(RangeGame, 'hits') ?? 0) + 1);
    game.setValue(RangeGame, 'score', (game.getValue(RangeGame, 'score') ?? 0) + points);
    game.setValue(RangeGame, 'lastHitPoints', points);
    game.setValue(RangeGame, 'hitPulse', 0.9);
    game.setValue(RangeGame, 'status', `+${points}`);
  }

  /**
   * Plays the shot through the pistol's positional AudioSource. Browsers start
   * the listener's AudioContext suspended until a user gesture, and the shot
   * itself is that gesture, so resume it here before requesting playback.
   */
  private playShot(gun: Entity): void {
    this.resumeAudio();
    gun.setValue(AudioSource, '_playRequested', true);
  }

  /** The shot itself counts as the gesture that unlocks audio playback. */
  private resumeAudio(): void {
    const context = this.audioContext ?? this.findAudioContext();
    this.audioContext = context;
    if (context != null && context.state === 'suspended') {
      void context.resume();
    }
  }

  private findAudioContext(): AudioContext | null {
    const listener = this.player.head.children.find(
      (child): child is AudioListener => child instanceof AudioListener,
    );
    return listener?.context ?? null;
  }

  /**
   * Pointer and key events unlock the listener's AudioContext for players who
   * shoot before entering a session (flat mode) or reach for the panel first.
   */
  private bindAudioUnlock(): void {
    const resume = () => this.resumeAudio();
    document.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    this.cleanupFuncs.push(
      () => document.removeEventListener('pointerdown', resume),
      () => window.removeEventListener('keydown', resume),
    );
  }

  /**
   * Draws the tracer on the shot ray itself, in the pistol's local space. It
   * deliberately ignores the recoil pose so the line cannot flick upward after
   * the shot.
   */
  private placeTracer(gun: Entity, runtime: GunRuntime, distance: number): void {
    const gunObject = gun.object3D;
    const tracer = runtime.tracer;
    if (gunObject == null || tracer == null) {
      return;
    }

    const length = Math.min(distance, MAX_TRACER_LENGTH);
    this.tracerMid
      .copy(this.shotDirection)
      .multiplyScalar(length * 0.5)
      .add(this.shotOrigin);
    gunObject.worldToLocal(this.tracerMid);
    gunObject.getWorldQuaternion(this.tracerParentQuaternion);

    tracer.position.copy(this.tracerMid);
    tracer.quaternion
      .copy(this.tracerParentQuaternion)
      .invert()
      .multiply(this.shotQuaternion);
    tracer.scale.set(1, 1, length / TRACER_UNIT);
    tracer.visible = true;
  }

  /** Walks up from a hit mesh until it reaches one of the candidate heads. */
  private rootHead(object: Object3D | null): Object3D | null {
    let current = object;
    while (current != null) {
      if (this.candidates.includes(current)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  private entityForHead(head: Object3D | null): Entity | null {
    if (head == null) {
      return null;
    }
    for (const target of this.queries.targets.entities) {
      const state = this.targetState(target);
      if (state.head === head) {
        return target;
      }
    }
    return null;
  }

  private updateTargets(game: Entity, delta: number): void {
    const frozen = game.getValue(RangeGame, 'finished') === true;
    let active = 0;
    let readyCount = 0;
    let ready: Entity | null = null;

    for (const target of this.queries.targets.entities) {
      const stateValue = target.getValue(Target, 'state') ?? TargetState.Down;
      const timer = target.getValue(Target, 'timer') ?? 0;
      let angle = target.getValue(Target, 'angle') ?? DOWN_ANGLE;
      const runtime = this.targetState(target);

      if (stateValue === TargetState.Up || stateValue === TargetState.Rising) {
        active += 1;
      }

      const goal = stateValue === TargetState.Up || stateValue === TargetState.Rising ? 0 : DOWN_ANGLE;
      const rate = stateValue === TargetState.Rising ? RISE_RATE : FALL_RATE;
      const distanceToGoal = goal - angle;
      if (Math.abs(distanceToGoal) > 0.0005) {
        const step = Math.min(Math.abs(distanceToGoal), rate * delta);
        angle += Math.sign(distanceToGoal) * step;
        target.setValue(Target, 'angle', angle);
        if (runtime.arm != null) {
          runtime.arm.rotation.x = angle;
        }
      }

      if (stateValue === TargetState.Rising && Math.abs(goal - angle) < 0.02) {
        target.setValue(Target, 'state', TargetState.Up);
        target.setValue(Target, 'timer', UP_SECONDS);
      } else if (stateValue === TargetState.Hit && Math.abs(goal - angle) < 0.02) {
        target.setValue(Target, 'state', TargetState.Down);
        target.setValue(Target, 'timer', RESPAWN_DELAY);
      } else if (stateValue === TargetState.Up) {
        if (timer - delta <= 0) {
          target.setValue(Target, 'state', TargetState.Down);
          target.setValue(Target, 'timer', RESPAWN_DELAY);
        } else {
          target.setValue(Target, 'timer', timer - delta);
        }
      } else if (stateValue === TargetState.Down && timer > 0) {
        target.setValue(Target, 'timer', timer - delta);
      }

      if (stateValue === TargetState.Down && timer <= 0) {
        readyCount += 1;
        if (Math.random() < 1 / readyCount) {
          ready = target;
        }
      }
    }

    if (frozen || active >= ACTIVE_TARGETS || ready == null) {
      return;
    }
    this.spawnTimer -= delta;
    if (this.spawnTimer > 0) {
      return;
    }
    this.spawnTimer = SPAWN_INTERVAL;
    ready.setValue(Target, 'state', TargetState.Rising);
  }

  /** Runs on every gun, so a shot fired the instant the pistol is dropped
   * still clears its flash and tracer. */
  private updateGunFeedback(delta: number): void {
    for (const gun of this.queries.guns.entities) {
      this.tickGun(gun, delta);
    }
  }

  private tickGun(gun: Entity, delta: number): void {
    const cooldown = Math.max(0, (gun.getValue(Gun, 'cooldown') ?? 0) - delta);
    if (cooldown !== (gun.getValue(Gun, 'cooldown') ?? 0)) {
      gun.setValue(Gun, 'cooldown', cooldown);
    }

    const gunObject = gun.object3D;
    if (gunObject == null) {
      return;
    }
    const runtime = this.gunState(gun, gunObject);
    const hand = this.world.getSystem(GrabSystem)?.getHolderHand(gun) ?? null;

    if (hand != null) {
      this.alignGunToRay(hand, gunObject, runtime);
    }

    const recoil = Math.max(
      0,
      (gun.getValue(Gun, 'recoil') ?? 0) - delta * 6.5,
    );
    if (recoil !== (gun.getValue(Gun, 'recoil') ?? 0)) {
      gun.setValue(Gun, 'recoil', recoil);
    }
    if (runtime.recoil != null) {
      this.recoilTilt.setFromAxisAngle(this.xAxis, recoil * 0.24);
      runtime.recoil.quaternion
        .copy(runtime.correction)
        .multiply(this.recoilTilt);
      runtime.recoil.position.z = recoil * 0.035;
    }

    const flashTime = Math.max(0, (gun.getValue(Gun, 'flashTime') ?? 0) - delta);
    if (flashTime !== (gun.getValue(Gun, 'flashTime') ?? 0)) {
      gun.setValue(Gun, 'flashTime', flashTime);
      if (runtime.flash != null) {
        runtime.flash.visible = flashTime > 0;
      }
    }

    const tracerTime = Math.max(0, (gun.getValue(Gun, 'tracerTime') ?? 0) - delta);
    if (tracerTime !== (gun.getValue(Gun, 'tracerTime') ?? 0)) {
      gun.setValue(Gun, 'tracerTime', tracerTime);
      if (runtime.tracer != null) {
        runtime.tracer.visible = tracerTime > 0;
      }
    }
  }

  private targetState(target: Entity): TargetRuntime {
    let runtime = this.targetRuntime.get(target.index);
    if (runtime == null) {
      runtime = { arm: null, head: null };
      this.targetRuntime.set(target.index, runtime);
    }
    if ((runtime.arm == null || runtime.head == null) && target.object3D != null) {
      runtime.arm = runtime.arm ?? target.object3D.getObjectByName('Arm') ?? null;
      runtime.head = runtime.head ?? target.object3D.getObjectByName('Head') ?? null;
      if (runtime.arm != null) {
        runtime.arm.rotation.x = target.getValue(Target, 'angle') ?? DOWN_ANGLE;
      }
    }
    return runtime;
  }

  /**
   * A proximity grab seats the object on the controller's grip pose, so the
   * pistol sits canted relative to where the player points. Cancelling that
   * every frame keeps the barrel on the hand's pointing ray while leaving the
   * grab itself rigid.
   */
  private alignGunToRay(
    hand: string,
    gunObject: Object3D,
    runtime: GunRuntime,
  ): void {
    const ray =
      hand === 'left' ? this.player.raySpaces.left : this.player.raySpaces.right;
    gunObject.getWorldQuaternion(this.gunQuaternion);
    ray.getWorldQuaternion(this.rayQuaternion);
    runtime.correction
      .copy(this.gunQuaternion)
      .invert()
      .multiply(this.rayQuaternion);
  }

  private resetGunPose(gun: Entity): void {
    const runtime = this.gunRuntime.get(gun.index);
    if (runtime == null) {
      return;
    }
    runtime.correction.identity();
    if (runtime.recoil != null) {
      runtime.recoil.quaternion.identity();
      runtime.recoil.position.set(0, 0, 0);
    }
  }

  private gunState(gun: Entity, gunObject: Object3D): GunRuntime {
    let runtime = this.gunRuntime.get(gun.index);
    if (runtime == null) {
      runtime = {
        recoil: null,
        muzzle: null,
        flash: null,
        tracer: null,
        correction: new Quaternion(),
      };
      this.gunRuntime.set(gun.index, runtime);
    }
    runtime.recoil = runtime.recoil ?? gunObject.getObjectByName('Recoil') ?? null;
    runtime.muzzle = runtime.muzzle ?? gunObject.getObjectByName('Muzzle') ?? null;
    runtime.flash = runtime.flash ?? gunObject.getObjectByName('MuzzleFlash') ?? null;
    runtime.tracer = runtime.tracer ?? gunObject.getObjectByName('Tracer') ?? null;
    return runtime;
  }
}
