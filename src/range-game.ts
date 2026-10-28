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
import { Gun, Magazine, RangeGame, Target, TargetState } from './range-components.js';

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
/** Seconds a spent magazine stays away before it reappears on the bench. */
const MAG_RESPAWN_DELAY = 1.2;
/** How close a held magazine has to get to the grip well to seat. */
const MAG_INSERT_RADIUS = 0.18;
/** Rearward travel of the free hand that counts as racking the slide. */
const RACK_DISTANCE = 0.055;
/** How far the slide sits back while it is locked open on an empty mag. */
const SLIDE_LOCK_BACK = 0.02;
/** Slide travel per unit of hand pull, so the gesture reads at arm's length. */
const SLIDE_PULL_RATIO = 0.55;
const DEFAULT_STATUS = 'Grab the pistol and pull the trigger';
const EMPTY_STATUS = 'Out of ammo. Press A to drop the magazine';
const NO_MAG_STATUS = 'Magazine out. Grab a spare and press it into the grip';
const RACK_STATUS = 'Rack the slide to chamber a round';
const FINISHED_STATUS = 'Round over. Pull the trigger to go again';

type TargetRuntime = { arm: Object3D | null; head: Object3D | null };
type GunRuntime = {
  recoil: Object3D | null;
  slide: Object3D | null;
  muzzle: Object3D | null;
  flash: Object3D | null;
  tracer: Object3D | null;
  correction: Quaternion;
};
type RackRuntime = { tracking: boolean; minZ: number; pull: number };
type MagRuntime = {
  home: Vector3;
  homeQuaternion: Quaternion;
  rounds: Object3D | null;
  captured: boolean;
};

export class RangeGameSystem extends createSystem({
  game: { required: [RangeGame] },
  targets: { required: [Target] },
  guns: { required: [Gun] },
  heldGuns: { required: [Gun, Grabbed] },
  magazines: { required: [Magazine] },
  heldMagazines: { required: [Magazine, Grabbed] },
}) {
  private readonly targetRuntime = new Map<number, TargetRuntime>();
  private readonly gunRuntime = new Map<number, GunRuntime>();
  private readonly magRuntime = new Map<number, MagRuntime>();
  private readonly raycaster = new Raycaster();
  private readonly shotOrigin = new Vector3();
  private readonly shotDirection = new Vector3();
  private readonly shotQuaternion = new Quaternion();
  private readonly gunQuaternion = new Quaternion();
  private readonly rayQuaternion = new Quaternion();
  private readonly tracerMid = new Vector3();
  private readonly tracerParentQuaternion = new Quaternion();
  private readonly recoilTilt = new Quaternion();
  private readonly insertPoint = new Vector3();
  private readonly magPosition = new Vector3();
  private readonly handWorld = new Vector3();
  private readonly handLocal = new Vector3();
  private readonly rackRuntime = new Map<number, RackRuntime>();
  private readonly xAxis = new Vector3(1, 0, 0);
  private readonly candidates: Object3D[] = [];
  private audioContext: AudioContext | null = null;
  private gunMech: Entity | null = null;
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
    this.handleEject(game);
    this.updateTargets(game, delta);
    this.updateReload(game, delta);
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
    this.refillGuns();
    this.restoreMagazines();
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
        game.setValue(RangeGame, 'status', this.idleStatus(game));
      }
    } else {
      game.setValue(RangeGame, 'hitPulse', pulse);
    }
  }

  /** The status to fall back to once a hit or reload message times out. */
  private idleStatus(game: Entity): string {
    if (game.getValue(RangeGame, 'finished') === true) {
      return FINISHED_STATUS;
    }
    const issue = this.gunIssue(this.firstGun());
    if (issue != null) {
      return issue;
    }
    return game.getValue(RangeGame, 'running') === true
      ? 'Live. Keep shooting'
      : DEFAULT_STATUS;
  }

  /** What stops this pistol from firing, if anything. */
  private gunIssue(gun: Entity | null): string | null {
    if (gun == null) {
      return null;
    }
    if (gun.getValue(Gun, 'magIn') === false) {
      return NO_MAG_STATUS;
    }
    if ((gun.getValue(Gun, 'ammo') ?? 0) <= 0) {
      return EMPTY_STATUS;
    }
    if (gun.getValue(Gun, 'needsRack') === true) {
      return RACK_STATUS;
    }
    return null;
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
    if (
      gun.getValue(Gun, 'needsRack') === true ||
      gun.getValue(Gun, 'magIn') === false ||
      (gun.getValue(Gun, 'ammo') ?? 0) <= 0
    ) {
      this.dryFire(game, gun);
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
      const ammo = Math.max(0, (gun.getValue(Gun, 'ammo') ?? 1) - 1);
      gun.setValue(Gun, 'ammo', ammo);
      if (ammo <= 0) {
        // The last round leaves the slide locked back until it is racked.
        gun.setValue(Gun, 'needsRack', true);
      }
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
      // Running the magazine dry turns the HUD status into the next step.
      if (gun != null) {
        const issue = this.gunIssue(gun);
        if (issue != null) {
          game.setValue(RangeGame, 'status', issue);
        }
      }
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

  /** A trigger pull that cannot fire still clicks. */
  private dryFire(game: Entity, gun: Entity): void {
    gun.setValue(Gun, 'cooldown', 0.35);
    game.setValue(RangeGame, 'status', this.gunIssue(gun) ?? EMPTY_STATUS);
    this.playDry(game);
  }

  /** The pistol's click doubles as dry-fire and magazine-seat feedback. */
  private playDry(game: Entity): void {
    this.resumeAudio();
    game.setValue(AudioSource, '_playRequested', true);
  }

  private firstGun(): Entity | null {
    for (const gun of this.queries.guns.entities) {
      return gun;
    }
    return null;
  }

  /**
   * A on the right controller drops the seated magazine, Metro-style. Any
   * rounds still in it are lost, and the grip is empty until a spare is pushed
   * in. The slide state is untouched: only firing dry locks it back.
   */
  private handleEject(game: Entity): void {
    const eject =
      this.input.xr.gamepads.right?.getButtonDown(InputComponent.A_Button) ===
      true;
    if (!eject) {
      return;
    }
    const gun = this.firstHeldGun() ?? this.firstGun();
    if (gun == null || gun.getValue(Gun, 'magIn') === false) {
      return;
    }
    gun.setValue(Gun, 'magIn', false);
    gun.setValue(Gun, 'ammo', 0);
    this.playDry(game);
    game.setValue(RangeGame, 'status', NO_MAG_STATUS);
  }

  /**
   * Entering the slide with the free hand and pulling it rearward chambers a
   * round when the slide is locked back. Cosmetic when the gun is already
   * chambered, so nothing is racked twice by accident.
   */
  private updateRack(game: Entity, gun: Entity, delta: number): void {
    const gunObject = gun.object3D;
    if (gunObject == null) {
      return;
    }
    const runtime = this.gunState(gun, gunObject);
    const slide = runtime.slide;
    if (slide == null) {
      return;
    }
    // The visible pistol is the recoil group corrected onto the hand ray, so
    // measure the free hand there rather than in the grabbed root's frame.
    const frame = runtime.recoil ?? gunObject;

    let state = this.rackRuntime.get(gun.index);
    if (state == null) {
      state = { tracking: false, minZ: 0, pull: 0 };
      this.rackRuntime.set(gun.index, state);
    }

    const rackable =
      gun.getValue(Gun, 'needsRack') === true &&
      gun.getValue(Gun, 'magIn') !== false &&
      (gun.getValue(Gun, 'ammo') ?? 0) > 0;
    const holder =
      this.world.getSystem(GrabSystem)?.getHolderHand(gun) ?? null;

    if (rackable && holder != null) {
      const hand =
        holder === 'left'
          ? this.player.gripSpaces.right
          : this.player.gripSpaces.left;
      gunObject.updateWorldMatrix(true, false);
      frame.updateWorldMatrix(true, false);
      hand.getWorldPosition(this.handWorld);
      this.handLocal.copy(frame.worldToLocal(this.handWorld));
      const onSlide =
        this.handLocal.y > -0.02 &&
        this.handLocal.y < 0.13 &&
        Math.abs(this.handLocal.x) < 0.13 &&
        this.handLocal.z > -0.22 &&
        this.handLocal.z < 0.2;
      if (onSlide) {
        if (!state.tracking) {
          state.tracking = true;
          state.minZ = this.handLocal.z;
        }
        // Measure from the most forward point the hand reaches on the slide,
        // so entering the zone from the rear still allows a full pull.
        state.minZ = Math.min(state.minZ, this.handLocal.z);
        state.pull = Math.max(0, this.handLocal.z - state.minZ);
        if (state.pull >= RACK_DISTANCE) {
          state.tracking = false;
          state.pull = 0;
          this.completeRack(game, gun);
        }
      } else {
        state.tracking = false;
        state.pull = 0;
      }
    } else {
      state.tracking = false;
      state.pull = 0;
    }

    const locked = gun.getValue(Gun, 'needsRack') === true;
    const pull = locked ? Math.min(state.pull, RACK_DISTANCE) : 0;
    if (Math.abs((gun.getValue(Gun, 'rackPull') ?? 0) - pull) > 0.001) {
      gun.setValue(Gun, 'rackPull', pull);
    }
    const reach = locked
      ? SLIDE_LOCK_BACK + pull * SLIDE_PULL_RATIO
      : 0;
    slide.position.z += (reach - slide.position.z) * Math.min(1, delta * 20);
  }

  private completeRack(game: Entity, gun: Entity): void {
    gun.setValue(Gun, 'needsRack', false);
    this.playRack();
    game.setValue(RangeGame, 'status', 'Slide racked. Keep shooting');
    game.setValue(RangeGame, 'hitPulse', 0.9);
  }

  private playRack(): void {
    this.resumeAudio();
    if (this.gunMech == null) {
      this.gunMech = this.world.getSceneEntity('gun-mech') ?? null;
    }
    this.gunMech?.setValue(AudioSource, '_playRequested', true);
  }

  /**
   * Ticks spent magazines back onto the bench and seats a held one once it
   * reaches the pistol's grip well. Runs after shooting, so a magazine grabbed
   * the instant the gun runs dry still seats on that frame.
   */
  private updateReload(game: Entity, delta: number): void {
    for (const magazine of this.queries.magazines.entities) {
      if (magazine.getValue(Magazine, 'ready') !== false) {
        continue;
      }
      const timer = (magazine.getValue(Magazine, 'respawn') ?? 0) - delta;
      if (timer <= 0) {
        this.restoreMagazine(magazine);
      } else {
        magazine.setValue(Magazine, 'respawn', timer);
      }
    }

    const gun = this.firstGun();
    if (gun == null) {
      return;
    }
    this.updateRack(game, gun, delta);

    const magazine = this.heldMagazine();
    if (magazine == null) {
      return;
    }
    // A seated magazine has to come out (A) before a spare can go in.
    if (gun.getValue(Gun, 'magIn') !== false) {
      return;
    }
    if (!this.magazineAtGrip(gun, magazine)) {
      return;
    }
    this.seatMagazine(game, gun, magazine);
  }

  private heldMagazine(): Entity | null {
    for (const magazine of this.queries.heldMagazines.entities) {
      if (magazine.getValue(Magazine, 'ready') !== false) {
        return magazine;
      }
    }
    return null;
  }

  /** True while the held magazine is inside the pistol's grip well. */
  private magazineAtGrip(gun: Entity, magazine: Entity): boolean {
    const gunObject = gun.object3D;
    const magObject = magazine.object3D;
    if (gunObject == null || magObject == null) {
      return false;
    }
    gunObject.updateWorldMatrix(true, false);
    this.insertPoint.set(0, -0.06, 0);
    gunObject.localToWorld(this.insertPoint);
    magObject.updateWorldMatrix(true, false);
    magObject.getWorldPosition(this.magPosition);
    return (
      this.insertPoint.distanceToSquared(this.magPosition) <=
      MAG_INSERT_RADIUS * MAG_INSERT_RADIUS
    );
  }

  private seatMagazine(game: Entity, gun: Entity, magazine: Entity): void {
    const size = gun.getValue(Gun, 'magazineSize') ?? 6;
    const rounds = Math.min(size, magazine.getValue(Magazine, 'rounds') ?? size);
    gun.setValue(Gun, 'ammo', rounds);
    gun.setValue(Gun, 'magIn', true);
    gun.setValue(
      Gun,
      'cooldown',
      Math.max(gun.getValue(Gun, 'cooldown') ?? 0, 0.2),
    );

    magazine.setValue(Magazine, 'ready', false);
    magazine.setValue(Magazine, 'respawn', MAG_RESPAWN_DELAY);
    const state = this.magState(magazine);
    if (state.rounds != null) {
      state.rounds.visible = false;
    }
    // Hiding beats leaving a spent magazine floating where the hand let go.
    this.world.getSystem(GrabSystem)?.forceRelease(magazine);
    if (magazine.object3D != null) {
      magazine.object3D.visible = false;
    }

    this.playDry(game);
    game.setValue(
      RangeGame,
      'status',
      gun.getValue(Gun, 'needsRack') === true
        ? 'Magazine in. Pull the slide back to chamber a round'
        : `Magazine in. ${rounds} rounds`,
    );
    game.setValue(RangeGame, 'hitPulse', 0.9);
  }

  private restoreMagazine(magazine: Entity): void {
    const state = this.magState(magazine);
    magazine.setValue(Magazine, 'ready', true);
    magazine.setValue(Magazine, 'respawn', 0);
    if (state.rounds != null) {
      state.rounds.visible = true;
    }

    const object = magazine.object3D;
    if (object == null) {
      return;
    }
    object.visible = true;
    // A magazine still in hand keeps its pose; the rest go back on the bench.
    if (this.world.getSystem(GrabSystem)?.getHolderHand(magazine) != null) {
      return;
    }
    if (!state.captured) {
      return;
    }
    object.position.copy(state.home);
    object.quaternion.copy(state.homeQuaternion);
  }

  private restoreMagazines(): void {
    for (const magazine of this.queries.magazines.entities) {
      this.restoreMagazine(magazine);
    }
  }

  private refillGuns(): void {
    for (const gun of this.queries.guns.entities) {
      gun.setValue(Gun, 'ammo', gun.getValue(Gun, 'magazineSize') ?? 6);
      gun.setValue(Gun, 'magIn', true);
      gun.setValue(Gun, 'needsRack', false);
      gun.setValue(Gun, 'rackPull', 0);
      const runtime = this.rackRuntime.get(gun.index);
      if (runtime != null) {
        runtime.tracking = false;
        runtime.pull = 0;
      }
    }
  }

  private magState(magazine: Entity): MagRuntime {
    let runtime = this.magRuntime.get(magazine.index);
    if (runtime == null) {
      runtime = {
        home: new Vector3(),
        homeQuaternion: new Quaternion(),
        rounds: null,
        captured: false,
      };
      this.magRuntime.set(magazine.index, runtime);
    }
    const object = magazine.object3D;
    if (!runtime.captured && object != null) {
      runtime.home.copy(object.position);
      runtime.homeQuaternion.copy(object.quaternion);
      runtime.rounds = object.getObjectByName('Rounds') ?? null;
      runtime.captured = true;
    }
    return runtime;
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
        slide: null,
        muzzle: null,
        flash: null,
        tracer: null,
        correction: new Quaternion(),
      };
      this.gunRuntime.set(gun.index, runtime);
    }
    runtime.recoil = runtime.recoil ?? gunObject.getObjectByName('Recoil') ?? null;
    runtime.slide = runtime.slide ?? gunObject.getObjectByName('Slide') ?? null;
    runtime.muzzle = runtime.muzzle ?? gunObject.getObjectByName('Muzzle') ?? null;
    runtime.flash = runtime.flash ?? gunObject.getObjectByName('MuzzleFlash') ?? null;
    runtime.tracer = runtime.tracer ?? gunObject.getObjectByName('Tracer') ?? null;
    return runtime;
  }
}
