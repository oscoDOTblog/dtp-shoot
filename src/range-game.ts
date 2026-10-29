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
  Matrix4,
  Mesh,
  Quaternion,
  Raycaster,
  Transform,
  Vector3,
  createSystem,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  AmmoMode,
  Gun,
  Magazine,
  RangeGame,
  Target,
  TargetState,
  WEAPON_MAGAZINE,
  WeaponKind,
} from './range-components.js';
import type { WeaponKindValue } from './range-components.js';

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
/** Shorter, more forgiving pull for the SMG charging handle. */
const SMG_RACK_DISTANCE = 0.038;
/** Slide travel per unit of hand pull, so the gesture reads at arm's length. */
const SLIDE_PULL_RATIO = 0.55;
/** Squeeze needed on the free hand before the slide can be racked. */
const GRAB_THRESHOLD = 0.5;
/** Generous support-hand capture radius around the SMG foregrip. */
const SMG_SUPPORT_RADIUS = 0.28;
/** How far below its bench pose an inactive weapon waits, out of grab range. */
const PARKED_OFFSET = 5;
/** Seconds an ejected magazine spends falling, settling, then disappearing. */
const MAG_DROP_LIFETIME = 3.0;
/** Floor height the dropped magazine lands on. */
const MAG_DROP_FLOOR = 0.002;
/** Bench top: a magazine ejected over the table lands on it, not under it. */
const BENCH_TOP = 0.932;
const BENCH_MIN_X = -0.74;
const BENCH_MAX_X = 0.74;
const BENCH_MIN_Z = -1.34;
const BENCH_MAX_Z = -0.56;
/** Spark of spin on a dropped magazine, in radians per second. */
const MAG_DROP_SPIN = 7.2;
const DEFAULT_STATUS = 'Grab the pistol and pull the trigger';
const EMPTY_STATUS = 'Out of ammo. Press A to drop the magazine';
const NO_MAG_STATUS = 'Magazine out. Grab a spare and press it into the grip';
const PISTOL_RACK_STATUS = 'Grab the slide with your free hand and pull it back';
const SMG_RACK_STATUS = 'Grab the bolt with your free hand and pull it back';
const UNLIMITED_STATUS = 'Unlimited ammo. Pull the trigger';
const UNLIMITED_LIVE_STATUS = 'Unlimited ammo. Keep shooting';
const FINISHED_STATUS = 'Round over. Pull the trigger to go again';
const HEIGHT_STORAGE_KEY = 'dtp-shoot.experience-height-offset';
const HEIGHT_MIN = -0.5;
const HEIGHT_MAX = 0.5;

type TargetRuntime = { arm: Object3D | null; head: Object3D | null };
type GunRuntime = {
  aimFrame: Object3D | null;
  gripPoint: Object3D | null;
  supportPoint: Object3D | null;
  supportLatched: boolean;
  slide: Object3D | null;
  muzzle: Object3D | null;
  flash: Object3D | null;
  tracer: Object3D | null;
  magWell: Object3D | null;
  magEject: Object3D | null;
  rackZone: Object3D | null;
  /** Cached local bounds of `RackZone`, measured once. */
  zoneMin: Vector3;
  zoneMax: Vector3;
  zoneReady: boolean;
  correction: Quaternion;
};
type RackRuntime = { tracking: boolean; minZ: number; pull: number };
type MagRuntime = {
  home: Vector3;
  homeQuaternion: Quaternion;
  parent: Object3D | null;
  rounds: Object3D | null;
  captured: boolean;
  parked: boolean;
};
/** Authored bench pose of a weapon, so the loadout swap can park and restore it. */
type StashRuntime = {
  home: Vector3;
  homeQuaternion: Quaternion;
  parent: Object3D | null;
  captured: boolean;
  parked: boolean;
};
type DropRuntime = {
  entity: Entity | null;
  resolved: boolean;
  active: boolean;
  age: number;
  velocityY: number;
  spin: number;
  groundY: number;
  resting: boolean;
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
  private readonly magazineQuaternion = new Quaternion();
  private readonly magazineParentQuaternion = new Quaternion();
  private readonly rayQuaternion = new Quaternion();
  private readonly tracerMid = new Vector3();
  private readonly tracerParentQuaternion = new Quaternion();
  private readonly insertPoint = new Vector3();
  private readonly magPosition = new Vector3();
  private readonly handWorld = new Vector3();
  private readonly handLocal = new Vector3();
  private readonly gunWorld = new Vector3();
  private readonly gripWorld = new Vector3();
  private readonly supportWorld = new Vector3();
  private readonly supportHandWorld = new Vector3();
  private readonly rootWorldTarget = new Vector3();
  private readonly twoHandForward = new Vector3();
  private readonly twoHandRight = new Vector3();
  private readonly twoHandUp = new Vector3();
  private readonly twoHandZ = new Vector3();
  private readonly worldUp = new Vector3(0, 1, 0);
  private readonly twoHandBasis = new Matrix4();
  private readonly desiredQuaternion = new Quaternion();
  private readonly xAxis = new Vector3(1, 0, 0);
  private readonly rackRuntime = new Map<number, RackRuntime>();
  private readonly grabbedMagazines = new Set<number>();
  private readonly candidates: Object3D[] = [];
  private readonly dropPosition = new Vector3();
  private readonly dropQuaternion = new Quaternion();
  private readonly drops = new Map<WeaponKindValue, DropRuntime>();
  private readonly stash = new Map<number, StashRuntime>();
  private audioContext: AudioContext | null = null;
  private gunMech: Entity | null = null;
  private smgMech: Entity | null = null;
  private gunAlert: Entity | null = null;
  private alertResolved = false;
  private dropCount = 0;
  private spawnTimer = 0;
  private syncedMode: string | null = null;
  private syncedMagazineSize = -1;
  private syncedWeapon: WeaponKindValue | null = null;
  private heightLoaded = false;
  private appliedHeight = Number.NaN;
  private levelRoot: Entity | null = null;
  private baseLevelY = 0;

  init(): void {
    this.raycaster.far = MAX_SHOT_DISTANCE;
    this.bindAudioUnlock();
    for (const magazine of this.queries.magazines.entities) {
      this.captureMagazineHome(magazine);
    }
    for (const gun of this.queries.guns.entities) {
      this.captureStash(gun);
    }
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

    this.syncHeightOffset(game);
    this.syncAmmoSettings(game);

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
    this.updateDroppedMagazine(delta);
  }

  private gameEntity(): Entity | null {
    for (const entity of this.queries.game.entities) {
      return entity;
    }
    return null;
  }

  /** Applies and persists the user-controlled vertical offset for the range. */
  private syncHeightOffset(game: Entity): void {
    if (!this.heightLoaded) {
      this.heightLoaded = true;
      const stored = Number.parseFloat(
        globalThis.localStorage?.getItem(HEIGHT_STORAGE_KEY) ?? '',
      );
      if (Number.isFinite(stored)) {
        game.setValue(
          RangeGame,
          'heightOffset',
          Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, stored)),
        );
      }
    }

    const height = game.getValue(RangeGame, 'heightOffset') ?? 0;
    if (this.levelRoot?.object3D != null && height === this.appliedHeight) {
      this.levelRoot.object3D.position.y = this.baseLevelY + height;
      return;
    }
    this.levelRoot ??= this.world.activeLevel.value ?? null;
    if (this.levelRoot == null) {
      return;
    }
    const position = this.levelRoot.getVectorView(Transform, 'position');
    if (Number.isNaN(this.appliedHeight)) {
      this.baseLevelY = position[1];
    }
    position[1] = this.baseLevelY + height;
    if (this.levelRoot.object3D != null) {
      this.levelRoot.object3D.position.y = this.baseLevelY + height;
    }
    this.appliedHeight = height;
    globalThis.localStorage?.setItem(HEIGHT_STORAGE_KEY, String(height));
  }

  /**
   * The bench panel writes the weapon, ammo mode and magazine size into the
   * singleton game state. Mirror any change onto the active weapon and its
   * magazines, swap the bench loadout when the weapon changes, and reset to a
   * clean, live state instead of leaving a gun dry or slid-open.
   */
  private syncAmmoSettings(game: Entity): void {
    if (this.queries.guns.entities.size === 0) {
      return;
    }
    const weapon = this.activeKind(game);

    // A weapon swap carries its own remembered magazine size.
    if (weapon !== this.syncedWeapon) {
      const outgoing = this.syncedWeapon;
      if (outgoing != null) {
        game.setValue(RangeGame, this.sizeField(outgoing), this.syncedMagazineSize);
      }
      const bounds = WEAPON_MAGAZINE[weapon];
      const remembered = game.getValue(RangeGame, this.sizeField(weapon)) ?? bounds.size;
      game.setValue(RangeGame, 'magazineSize', this.clampSize(remembered, weapon));
    }

    const rawSize = game.getValue(RangeGame, 'magazineSize') ?? 8;
    const size = this.clampSize(rawSize, weapon);
    const mode =
      (game.getValue(RangeGame, 'ammoMode') ?? AmmoMode.Reloading) as string;
    if (
      mode === this.syncedMode &&
      size === this.syncedMagazineSize &&
      weapon === this.syncedWeapon
    ) {
      return;
    }
    const first = this.syncedWeapon == null;
    const weaponChanged = !first && weapon !== this.syncedWeapon;
    this.syncedMode = mode;
    this.syncedMagazineSize = size;
    this.syncedWeapon = weapon;
    if (rawSize !== size) {
      game.setValue(RangeGame, 'magazineSize', size);
    }

    this.applyMagazineSize(weapon, size);
    game.setValue(RangeGame, this.sizeField(weapon), size);
    if (first) {
      // Adopt the authored setup, then bench only the loadout it asks for.
      this.applyLoadout(game);
      return;
    }
    if (weaponChanged) {
      this.applyLoadout(game);
    }

    this.refillGuns();
    this.restoreMagazines();
    game.setValue(
      RangeGame,
      'status',
      mode === AmmoMode.Unlimited ? UNLIMITED_STATUS : this.idleStatus(game),
    );
    game.setValue(RangeGame, 'hitPulse', 0.9);
  }

  /** Clamps a magazine size to the bounds of the weapon it belongs to. */
  private clampSize(size: number, weapon: WeaponKindValue): number {
    const bounds = WEAPON_MAGAZINE[weapon];
    return Math.min(bounds.max, Math.max(bounds.min, Math.round(size)));
  }

  /** The component field that remembers a weapon's magazine size. */
  private sizeField(weapon: WeaponKindValue): 'pistolMagazineSize' | 'smgMagazineSize' {
    return weapon === WeaponKind.SMG ? 'smgMagazineSize' : 'pistolMagazineSize';
  }

  private activeKind(game: Entity): WeaponKindValue {
    return (game.getValue(RangeGame, 'weapon') ?? WeaponKind.Pistol) as WeaponKindValue;
  }

  private isActiveGun(game: Entity, gun: Entity): boolean {
    return gun.getValue(Gun, 'kind') === this.activeKind(game);
  }

  /** Mirrors the magazine size onto one weapon's gun and spare magazines. */
  private applyMagazineSize(weapon: WeaponKindValue, size: number): void {
    for (const gun of this.queries.guns.entities) {
      if (gun.getValue(Gun, 'kind') === weapon) {
        gun.setValue(Gun, 'magazineSize', size);
      }
    }
    for (const magazine of this.queries.magazines.entities) {
      if (magazine.getValue(Magazine, 'kind') === weapon) {
        magazine.setValue(Magazine, 'rounds', size);
      }
    }
  }

  private isUnlimited(game: Entity): boolean {
    return (
      (game.getValue(RangeGame, 'ammoMode') ?? AmmoMode.Reloading) ===
      AmmoMode.Unlimited
    );
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
    this.spawnTimer = 0;
    for (const drop of this.drops.values()) {
      drop.active = false;
      drop.age = 0;
      drop.resting = false;
      const prop = drop.entity?.object3D;
      if (prop != null) {
        prop.visible = false;
      }
    }
    this.refillGuns();
    this.restoreMagazines();
    game.setValue(RangeGame, 'status', this.idleStatus(game));
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
    if (this.isUnlimited(game)) {
      return game.getValue(RangeGame, 'running') === true
        ? UNLIMITED_LIVE_STATUS
        : UNLIMITED_STATUS;
    }
    const gun = this.activeGun(game);
    const issue = this.gunIssue(game, gun);
    if (issue != null) {
      return issue;
    }
    if (game.getValue(RangeGame, 'running') === true) {
      return 'Live. Keep shooting';
    }
    return gun == null
      ? DEFAULT_STATUS
      : `Grab the ${this.weaponNoun(gun)} and pull the trigger`;
  }

  /** What stops this pistol from firing, if anything. */
  private gunIssue(game: Entity, gun: Entity | null): string | null {
    if (gun == null || this.isUnlimited(game)) {
      return null;
    }
    if (gun.getValue(Gun, 'magIn') === false) {
      return NO_MAG_STATUS;
    }
    if ((gun.getValue(Gun, 'ammo') ?? 0) <= 0) {
      return EMPTY_STATUS;
    }
    if (gun.getValue(Gun, 'needsRack') === true) {
      return gun.getValue(Gun, 'kind') === WeaponKind.SMG
        ? SMG_RACK_STATUS
        : PISTOL_RACK_STATUS;
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

    const held = this.firstHeldGun();
    // A full-auto weapon keeps firing for as long as the trigger is held; the
    // per-gun cooldown sets the cyclic rate.
    const autofire =
      held != null &&
      held.getValue(Gun, 'automatic') === true &&
      ((rightPad?.getButtonValue(InputComponent.Trigger) ?? 0) > 0.4 ||
        (leftPad?.getButtonValue(InputComponent.Trigger) ?? 0) > 0.4);

    if (!triggerDown && !autofire && !keyDown) {
      return;
    }

    if (held != null && (held.getValue(Gun, 'cooldown') ?? 0) <= 0) {
      this.fireFromGun(game, held);
      return;
    }

    // Desktop affordance: with no weapon in hand, Space shoots from the view ray.
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
    // Fire from the muzzle position, but along the holder's target ray. The
    // snapped gun model derives its orientation from that same ray through a
    // correction quaternion, so reading the shot back off the muzzle made the
    // hitscan depend on that pose solve; the ray itself is the aim the player
    // is pointing, and it cannot be skewed by grip snapping or pose order.
    const aim = runtime.muzzle ?? gunObject;
    aim.getWorldPosition(this.shotOrigin);
    const hand = this.world.getSystem(GrabSystem)?.getHolderHand(gun) ?? null;
    const twoHandedAim =
      hand != null &&
      gun.getValue(Gun, 'twoHanded') === true &&
      gun.getValue(Gun, 'kind') === WeaponKind.SMG &&
      this.isSupportHandActive(hand, runtime);
    if (twoHandedAim) {
      // The two-hand solver has already produced the corrected aim quaternion.
      // Compose it from the gun root and deliberately omit the transient
      // Keep hitscan and tracer on the intended aim line.
      gunObject.updateWorldMatrix(true, true);
      aim.getWorldPosition(this.shotOrigin);
      gunObject.getWorldQuaternion(this.gunQuaternion);
      this.shotQuaternion.copy(this.gunQuaternion).multiply(runtime.correction);
    } else if (hand != null) {
      const ray =
        hand === 'left' ? this.player.raySpaces.left : this.player.raySpaces.right;
      // Keep the physical shot at the snapped muzzle, but use the controller
      // target ray for aim. Grip snapping changes the weapon's pose relative
      // to the controller; mixing the snapped muzzle direction with the
      // controller's aim is what caused shots to miss after snapping.
      ray.getWorldQuaternion(this.shotQuaternion);
    } else {
      aim.getWorldQuaternion(this.shotQuaternion);
    }
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
      gun.setValue(Gun, 'flashTime', 0.055);
      gun.setValue(Gun, 'tracerTime', 0.035);
      if (!this.isUnlimited(game)) {
        const ammo = Math.max(0, (gun.getValue(Gun, 'ammo') ?? 1) - 1);
        gun.setValue(Gun, 'ammo', ammo);
        if (ammo <= 0) {
          // The last round leaves the slide locked back until it is racked.
          gun.setValue(Gun, 'needsRack', true);
          gun.setValue(Gun, 'slideLockedBack', true);
          this.playEmpty();
        }
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
        const issue = this.gunIssue(game, gun);
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
    game.setValue(RangeGame, 'status', this.gunIssue(game, gun) ?? EMPTY_STATUS);
    this.playDry(game);
  }

  /** The pistol's click doubles as dry-fire and magazine-seat feedback. */
  private playDry(game: Entity): void {
    this.resumeAudio();
    game.setValue(AudioSource, '_playRequested', true);
  }

  /** The weapon the bench currently has loaded. */
  private activeGun(game: Entity): Entity | null {
    const kind = this.activeKind(game);
    for (const gun of this.queries.guns.entities) {
      if (gun.getValue(Gun, 'kind') === kind) {
        return gun;
      }
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
    if (!eject || this.isUnlimited(game)) {
      return;
    }
    const gun = this.firstHeldGun() ?? this.activeGun(game);
    if (gun == null || gun.getValue(Gun, 'magIn') === false) {
      return;
    }
    gun.setValue(Gun, 'magIn', false);
    gun.setValue(Gun, 'ammo', 0);
    this.dropMagazine(game, gun);
    this.playMagOut(game);
    game.setValue(RangeGame, 'status', NO_MAG_STATUS);
  }

  /** The visual magazine prop that falls from the given weapon's well. */
  private dropState(kind: WeaponKindValue): DropRuntime {
    let drop = this.drops.get(kind);
    if (drop == null) {
      drop = {
        entity: null,
        resolved: false,
        active: false,
        age: 0,
        velocityY: 0,
        spin: 0,
        groundY: MAG_DROP_FLOOR,
        resting: false,
      };
      this.drops.set(kind, drop);
    }
    return drop;
  }

  private droppedMagazineEntity(kind: WeaponKindValue): Entity | null {
    const drop = this.dropState(kind);
    if (!drop.resolved) {
      const id = kind === WeaponKind.SMG ? 'smg-dropped-magazine' : 'dropped-magazine';
      drop.entity = this.world.getSceneEntity(id) ?? null;
      drop.resolved = drop.entity != null;
    }
    return drop.entity;
  }

  /**
   * Sends the ejected magazine out of the grip: it starts where the floorplate
   * sat, then falls and tumbles onto the bench (or the floor beyond it) before
   * being hidden. It is a purely visual prop with no grabbable or collider
   * components.
   */
  private dropMagazine(game: Entity, gun: Entity): void {
    const kind = (gun.getValue(Gun, 'kind') ?? WeaponKind.Pistol) as WeaponKindValue;
    const entity = this.droppedMagazineEntity(kind);
    const object = entity?.object3D;
    const gunObject = gun.object3D;
    if (object == null || gunObject == null) {
      return;
    }
    // Place the magazine relative to the weapon's corrected aim frame.
    const runtime = this.gunState(gun, gunObject);
    const frame = runtime.aimFrame ?? gunObject;
    frame.updateWorldMatrix(true, false);
    // `MagEject` is authored at the mouth of each weapon's magazine well.
    const eject = runtime.magEject;
    if (eject != null) {
      this.dropPosition.setFromMatrixPosition(eject.matrixWorld);
    } else {
      this.dropPosition.set(0, -0.1, 0.006);
      frame.localToWorld(this.dropPosition);
    }
    frame.getWorldQuaternion(this.dropQuaternion);

    object.position.copy(this.dropPosition);
    object.quaternion.copy(this.dropQuaternion);
    object.visible = true;

    this.dropCount += 1;
    const drop = this.dropState(kind);
    drop.active = true;
    drop.age = 0;
    drop.velocityY = -0.2;
    // Alternate the direction so repeated drops do not look identical.
    drop.spin = (this.dropCount % 2 === 0 ? -1 : 1) * MAG_DROP_SPIN;
    drop.groundY = this.dropGround(object.position.x, object.position.z);
    if (object.position.y < drop.groundY) {
      // A magazine released below the table top falls past it to the floor.
      drop.groundY = MAG_DROP_FLOOR;
    }
    drop.resting = false;
  }

  /** What a dropped magazine lands on: the table if over it, else the floor. */
  private dropGround(x: number, z: number): number {
    const onBench =
      x > BENCH_MIN_X && x < BENCH_MAX_X && z > BENCH_MIN_Z && z < BENCH_MAX_Z;
    return onBench ? BENCH_TOP : MAG_DROP_FLOOR;
  }

  /** Advances each ejected magazine's short fall, bounce and cleanup. */
  private updateDroppedMagazine(delta: number): void {
    for (const [kind, drop] of this.drops) {
      const object = this.droppedMagazineEntity(kind)?.object3D;
      if (object == null) {
        continue;
      }
      if (!drop.active) {
        // The prop is authored in the scene, so keep it parked out of sight.
        if (object.visible) {
          object.visible = false;
        }
        continue;
      }

      drop.age += delta;
      if (!drop.resting) {
        drop.velocityY -= 9.81 * delta;
        object.position.y += drop.velocityY * delta;
        object.rotateX(drop.spin * delta);
        object.rotateZ(drop.spin * 0.3 * delta);
        if (object.position.y <= drop.groundY) {
          object.position.y = drop.groundY;
          if (drop.velocityY < -1.4) {
            drop.velocityY = -drop.velocityY * 0.3;
            drop.spin *= -0.4;
          } else {
            drop.resting = true;
            drop.velocityY = 0;
            drop.spin = 0;
          }
        }
      }

      if (drop.age >= MAG_DROP_LIFETIME) {
        drop.active = false;
        drop.resting = false;
        object.visible = false;
      }
    }
  }

  private playMagOut(game: Entity): void {
    this.resumeAudio();
    const kind = this.activeKind(game);
    this.droppedMagazineEntity(kind)?.setValue(AudioSource, '_playRequested', true);
  }

  /**
   * The slide-locks-open clack plus a short two-note cue: the audible signal
   * that the magazine is spent and has to come out.
   */
  private playEmpty(): void {
    this.resumeAudio();
    if (!this.alertResolved) {
      this.gunAlert = this.world.getSceneEntity('gun-alert') ?? null;
      this.alertResolved = this.gunAlert != null;
    }
    this.gunAlert?.setValue(AudioSource, '_playRequested', true);
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
      const freeHand = holder === 'left' ? 'right' : 'left';
      const holdingMagazine = this.isHandHoldingMagazine(freeHand);
      const hand = this.player.gripSpaces[freeHand];
      // Racking is a grab, not a brush: the free hand has to be squeezed.
      const squeezing =
        (this.input.xr.gamepads[freeHand]?.getButtonValue(
          InputComponent.Squeeze,
        ) ?? 0) > GRAB_THRESHOLD;
      const squeezeStarted =
        this.input.xr.gamepads[freeHand]?.getButtonDown(InputComponent.Squeeze) ===
        true;
      gunObject.updateWorldMatrix(true, false);
      runtime.rackZone?.updateWorldMatrix(true, false);
      hand.getWorldPosition(this.handWorld);
      // Use the authored rack volume itself so slide interaction does not
      // depend on the two-hand support correction.
      if (runtime.rackZone != null) {
        this.handLocal.copy(runtime.rackZone.worldToLocal(this.handWorld));
      } else {
        this.handLocal.copy(this.handWorld);
      }
      // The rack zone is authored per weapon, so a short pistol slide and a
      // longer SMG bolt both accept a believable grab without hard-coded boxes.
      const inZone =
        runtime.zoneReady &&
        this.handLocal.x > runtime.zoneMin.x &&
        this.handLocal.x < runtime.zoneMax.x &&
        this.handLocal.y > runtime.zoneMin.y &&
        this.handLocal.y < runtime.zoneMax.y &&
        this.handLocal.z > runtime.zoneMin.z &&
        this.handLocal.z < runtime.zoneMax.z;
      // Once the free hand has acquired the slide, keep tracking while the
      // squeeze is held. Requiring zone overlap every frame made the SMG
      // release the pull as soon as the hand moved toward the rear stop.
      const acquired =
        state.tracking || (inZone && squeezing && squeezeStarted && !holdingMagazine);
      if (acquired && squeezing && !holdingMagazine) {
        if (!state.tracking) {
          state.tracking = true;
          state.minZ = this.handLocal.z;
        }
        // Measure from the most forward point the hand reaches on the slide,
        // so entering the zone from the rear still allows a full pull.
        state.minZ = Math.min(state.minZ, this.handLocal.z);
        state.pull = Math.max(0, this.handLocal.z - state.minZ);
        const rackDistance =
          gun.getValue(Gun, 'kind') === WeaponKind.SMG
            ? SMG_RACK_DISTANCE
            : RACK_DISTANCE;
        if (state.pull >= rackDistance) {
          state.tracking = false;
          state.pull = 0;
          this.completeRack(game, gun);
        }
      } else {
        // Letting go of the squeeze drops the slide back to its locked stop.
        state.tracking = false;
        state.pull = 0;
      }
    } else {
      state.tracking = false;
      state.pull = 0;
    }

    const needsRack = gun.getValue(Gun, 'needsRack') === true;
    const slideLockedBack = gun.getValue(Gun, 'slideLockedBack') === true;
    const rackDistance =
      gun.getValue(Gun, 'kind') === WeaponKind.SMG
        ? SMG_RACK_DISTANCE
        : RACK_DISTANCE;
    const pull = needsRack ? Math.min(state.pull, rackDistance) : 0;
    if (Math.abs((gun.getValue(Gun, 'rackPull') ?? 0) - pull) > 0.001) {
      gun.setValue(Gun, 'rackPull', pull);
    }
    const lockBack = gun.getValue(Gun, 'slideTravel') ?? 0.02;
    const pullTravel = (pull / rackDistance) * lockBack * SLIDE_PULL_RATIO;
    const reach = needsRack
      ? (slideLockedBack ? lockBack : 0) + pullTravel
      : 0;
    slide.position.z += (reach - slide.position.z) * Math.min(1, delta * 20);
  }

  private completeRack(game: Entity, gun: Entity): void {
      gun.setValue(Gun, 'needsRack', false);
    gun.setValue(Gun, 'slideLockedBack', false);
    this.playRack(game);
    const label = this.weaponLabel(gun);
    game.setValue(RangeGame, 'status', `${label} racked. Keep shooting`);
    game.setValue(RangeGame, 'hitPulse', 0.9);
  }

  private playRack(game: Entity): void {
    this.resumeAudio();
    const kind = this.activeKind(game);
    if (kind === WeaponKind.SMG) {
      if (this.smgMech == null) {
        this.smgMech = this.world.getSceneEntity('smg-mech') ?? null;
      }
      this.smgMech?.setValue(AudioSource, '_playRequested', true);
      return;
    }
    if (this.gunMech == null) {
      this.gunMech = this.world.getSceneEntity('gun-mech') ?? null;
    }
    this.gunMech?.setValue(AudioSource, '_playRequested', true);
  }

  /** "Pistol" / "SMG", for status lines. */
  private weaponLabel(gun: Entity): string {
    return gun.getValue(Gun, 'kind') === WeaponKind.SMG ? 'SMG' : 'Pistol';
  }

  /** Natural-language noun used in the idle grab prompt. */
  private weaponNoun(gun: Entity): string {
    return gun.getValue(Gun, 'kind') === WeaponKind.SMG ? 'SMG' : 'pistol';
  }

  /**
   * Ticks spent magazines back onto the bench and seats a held one once it
   * reaches the active weapon's magazine well. Runs after shooting, so a
   * magazine grabbed the instant the gun runs dry still seats on that frame.
   */
  private updateReload(game: Entity, delta: number): void {
    const kind = this.activeKind(game);
    const gun = this.activeGun(game);
    for (const magazine of this.queries.magazines.entities) {
      // The other weapon's magazines wait parked below the bench.
      if (magazine.getValue(Magazine, 'kind') !== kind) {
        continue;
      }
      const holder = this.world.getSystem(GrabSystem)?.getHolderHand(magazine);
      if (holder == null) {
        this.grabbedMagazines.delete(magazine.index);
      } else if (
        !this.grabbedMagazines.has(magazine.index) &&
        magazine.getValue(Magazine, 'ready') !== false
      ) {
        this.grabbedMagazines.add(magazine.index);
        this.snapMagazineOrientation(magazine, holder);
      }
      const state = this.magState(magazine);
      // Prove where a magazine belongs while it is still sitting untouched on
      // the bench. Capturing it later, mid-grab, recorded a midair pose and
      // respawned the magazine in the hand's last position.
      if (
        !state.captured &&
        magazine.getValue(Magazine, 'ready') !== false &&
        this.world.getSystem(GrabSystem)?.getHolderHand(magazine) == null
      ) {
        this.captureMagazineHome(magazine);
      }
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

    if (gun == null) {
      return;
    }
    this.updateRack(game, gun, delta);

    const magazine = this.heldMagazine(kind);
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

  private heldMagazine(kind: WeaponKindValue): Entity | null {
    for (const magazine of this.queries.heldMagazines.entities) {
      if (
        magazine.getValue(Magazine, 'ready') !== false &&
        magazine.getValue(Magazine, 'kind') === kind
      ) {
        return magazine;
      }
    }
    return null;
  }

  /** True while the held magazine is inside the weapon's magazine well. */
  private magazineAtGrip(gun: Entity, magazine: Entity): boolean {
    const gunObject = gun.object3D;
    const magObject = magazine.object3D;
    if (gunObject == null || magObject == null) {
      return false;
    }
    gunObject.updateWorldMatrix(true, false);
    const well = this.gunState(gun, gunObject).magWell;
    if (well != null) {
      this.insertPoint.setFromMatrixPosition(well.matrixWorld);
    } else {
      this.insertPoint.set(0, -0.06, 0);
      gunObject.localToWorld(this.insertPoint);
    }
    magObject.updateWorldMatrix(true, false);
    magObject.getWorldPosition(this.magPosition);
    return (
      this.insertPoint.distanceToSquared(this.magPosition) <=
      MAG_INSERT_RADIUS * MAG_INSERT_RADIUS
    );
  }

  /** Snap a newly grabbed magazine upright to the grabbing hand's pose. */
  private snapMagazineOrientation(
    magazine: Entity,
    holder: 'left' | 'right',
  ): void {
    const magazineObject = magazine.object3D;
    if (magazineObject == null) {
      return;
    }
    const hand = this.player.gripSpaces[holder];
    hand.getWorldQuaternion(this.magazineQuaternion);
    const parent = magazineObject.parent;
    if (parent != null) {
      parent.getWorldQuaternion(this.magazineParentQuaternion);
      magazineObject.quaternion
        .copy(this.magazineParentQuaternion)
        .invert()
        .multiply(this.magazineQuaternion);
    } else {
      magazineObject.quaternion.copy(this.magazineQuaternion);
    }
  }

  private seatMagazine(game: Entity, gun: Entity, magazine: Entity): void {
    const size = gun.getValue(Gun, 'magazineSize') ?? 6;
    const rounds = Math.min(size, magazine.getValue(Magazine, 'rounds') ?? size);
    const label = this.weaponLabel(gun);
    gun.setValue(Gun, 'ammo', rounds);
    gun.setValue(Gun, 'magIn', true);
    // Every fresh magazine requires a deliberate rack to chamber its first
    // round, not only magazines inserted after an empty lock-back.
    gun.setValue(Gun, 'needsRack', true);
    gun.setValue(
      Gun,
      'cooldown',
      Math.max(gun.getValue(Gun, 'cooldown') ?? 0, 0.2),
    );

    magazine.setValue(Magazine, 'ready', false);
    magazine.setValue(Magazine, 'respawn', MAG_RESPAWN_DELAY);
    const state = this.magState(magazine);
    if (state.rounds == null) {
      state.rounds = magazine.object3D?.getObjectByName('Rounds') ?? null;
    }
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
        ? `${label} magazine in. Rack it to chamber a round`
        : `${label} magazine in. ${rounds} rounds`,
    );
    game.setValue(RangeGame, 'hitPulse', 0.9);
  }

  private restoreMagazine(magazine: Entity): void {
    // A magazine belonging to the other weapon stays parked until it is loaded.
    const active = this.gameEntity();
    if (active != null && magazine.getValue(Magazine, 'kind') !== this.activeKind(active)) {
      return;
    }
    const state = this.magState(magazine);
    if (!state.captured) {
      this.captureMagazineHome(magazine);
    }
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
    state.parked = false;
    // A magazine still in hand keeps its pose; the rest go back on the bench.
    if (this.world.getSystem(GrabSystem)?.getHolderHand(magazine) != null) {
      return;
    }
    if (!state.captured) {
      return;
    }
    // Grabbing reparents the object onto the hand's scene root, so put it back
    // under its authored parent before restoring the bench-local pose.
    if (state.parent != null && object.parent !== state.parent) {
      state.parent.attach(object);
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
      gun.setValue(Gun, 'slideLockedBack', false);
      gun.setValue(Gun, 'rackPull', 0);
      const runtime = this.rackRuntime.get(gun.index);
      if (runtime != null) {
        runtime.tracking = false;
        runtime.pull = 0;
      }
    }
  }

  /**
   * Shows the selected weapon and its magazines, and parks the other loadout
   * well below the bench. Hiding alone is not enough: an invisible object can
   * still be inside the proximity grab volume, so the parked pose is what keeps
   * the wrong gun unreachable.
   */
  private applyLoadout(game: Entity): void {
    const kind = this.activeKind(game);
    for (const gun of this.queries.guns.entities) {
      this.applyStash(gun, gun.getValue(Gun, 'kind') === kind);
    }
    for (const magazine of this.queries.magazines.entities) {
      this.applyMagazineLoadout(magazine, magazine.getValue(Magazine, 'kind') === kind);
    }
  }

  private stashState(entity: Entity): StashRuntime {
    let runtime = this.stash.get(entity.index);
    if (runtime == null) {
      runtime = {
        home: new Vector3(),
        homeQuaternion: new Quaternion(),
        parent: null,
        captured: false,
        parked: false,
      };
      this.stash.set(entity.index, runtime);
    }
    return runtime;
  }

  /** Records a weapon's authored bench pose before anything is parked. */
  private captureStash(entity: Entity): void {
    const object = entity.object3D;
    if (object == null) {
      return;
    }
    const runtime = this.stashState(entity);
    if (runtime.captured) {
      return;
    }
    runtime.home.copy(object.position);
    runtime.homeQuaternion.copy(object.quaternion);
    runtime.parent = object.parent;
    runtime.captured = true;
  }

  private applyStash(entity: Entity, active: boolean): void {
    const object = entity.object3D;
    if (object == null) {
      return;
    }
    this.captureStash(entity);
    const runtime = this.stashState(entity);
    if (active) {
      if (runtime.parked) {
        if (runtime.parent != null && object.parent !== runtime.parent) {
          runtime.parent.attach(object);
        }
        object.position.copy(runtime.home);
        object.quaternion.copy(runtime.homeQuaternion);
        runtime.parked = false;
      }
      object.visible = true;
      return;
    }
    if (runtime.parked) {
      return;
    }
    this.world.getSystem(GrabSystem)?.forceRelease(entity);
    if (runtime.parent != null && object.parent !== runtime.parent) {
      runtime.parent.attach(object);
    }
    object.position.copy(runtime.home);
    object.position.y -= PARKED_OFFSET;
    object.quaternion.copy(runtime.homeQuaternion);
    object.visible = false;
    runtime.parked = true;
  }

  private applyMagazineLoadout(magazine: Entity, active: boolean): void {
    const object = magazine.object3D;
    if (object == null) {
      return;
    }
    const state = this.magState(magazine);
    if (!state.captured) {
      this.captureMagazineHome(magazine);
    }
    if (active) {
      if (state.parked) {
        this.restoreMagazine(magazine);
      }
      return;
    }
    if (state.parked) {
      return;
    }
    this.world.getSystem(GrabSystem)?.forceRelease(magazine);
    if (state.parent != null && object.parent !== state.parent) {
      state.parent.attach(object);
    }
    object.position.copy(state.home);
    object.position.y -= PARKED_OFFSET;
    object.quaternion.copy(state.homeQuaternion);
    object.visible = false;
    state.parked = true;
  }

  private magState(magazine: Entity): MagRuntime {
    let runtime = this.magRuntime.get(magazine.index);
    if (runtime == null) {
      runtime = {
        home: new Vector3(),
        homeQuaternion: new Quaternion(),
        parent: null,
        rounds: null,
        captured: false,
        parked: false,
      };
      this.magRuntime.set(magazine.index, runtime);
    }
    return runtime;
  }

  /** Records a magazine's bench pose while it is still where it belongs. */
  private captureMagazineHome(magazine: Entity): void {
    const state = this.magState(magazine);
    const object = magazine.object3D;
    if (object == null) {
      return;
    }
    state.home.copy(object.position);
    state.homeQuaternion.copy(object.quaternion);
    state.parent = object.parent;
    state.rounds = object.getObjectByName('Rounds') ?? null;
    state.captured = true;
  }

  /**
   * Draws the tracer on the shot ray itself, in the pistol's local space. It
   * uses the same shot direction as hitscan so the line matches the barrel aim.
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
      if (
        gun.getValue(Gun, 'twoHanded') === true &&
        gun.getValue(Gun, 'kind') === WeaponKind.SMG
      ) {
        this.alignTwoHandedSmg(hand, gunObject, runtime);
      }
    }

    if (runtime.aimFrame != null) {
      runtime.aimFrame.quaternion.copy(runtime.correction);
      runtime.aimFrame.position.set(0, 0, 0);
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
    const grip =
      hand === 'left' ? this.player.gripSpaces.left : this.player.gripSpaces.right;
    const holder = hand === 'left' ? 'left' : 'right';

    grip.getWorldPosition(this.handWorld);

    // Snap the authored grip point onto the primary hand, but leave the
    // controller's target ray responsible for the usable shooting angle.
    gunObject.getWorldPosition(this.gunWorld);
    if (runtime.gripPoint != null) {
      runtime.gripPoint.getWorldPosition(this.gripWorld);
      this.rootWorldTarget
        .copy(this.gunWorld)
        .add(this.handWorld)
        .sub(this.gripWorld);
      if (gunObject.parent != null) {
        gunObject.parent.worldToLocal(this.rootWorldTarget);
        gunObject.position.copy(this.rootWorldTarget);
      }
    }

    gunObject.getWorldQuaternion(this.gunQuaternion);
    {
      // The controller grip pose is a hand-placement anchor, not an aiming
      // direction. Use the target ray for a favorable shooting angle.
      const ray =
        holder === 'left' ? this.player.raySpaces.left : this.player.raySpaces.right;
      ray.getWorldQuaternion(this.rayQuaternion);
    }
    runtime.correction.copy(this.gunQuaternion).invert().multiply(this.rayQuaternion);
  }

  /**
   * Uses the free hand's squeeze position to capture the foregrip and its
   * target ray to determine the SMG's forward aim.
   * The primary hand remains the only GrabSystem owner; this support pose is
   * deliberately custom so it cannot fight OneHandGrabbable.
   */
  private alignTwoHandedSmg(
    holder: string,
    gunObject: Object3D,
    runtime: GunRuntime,
  ): void {
    if (!this.isSupportHandActive(holder, runtime)) {
      return;
    }
    // Aim from the primary grip toward the support-hand squeeze location.
    // Unlike a controller target ray, this preserves the physical two-hand
    // relationship and lets moving the support hand steer the barrel.
    const primaryGrip =
      holder === 'left' ? this.player.gripSpaces.left : this.player.gripSpaces.right;
    primaryGrip.getWorldPosition(this.handWorld);
    this.twoHandForward.copy(this.supportHandWorld).sub(this.handWorld);
    if (this.twoHandForward.lengthSq() < 0.0001) {
      return;
    }
    this.twoHandForward.normalize();
    this.twoHandZ.copy(this.twoHandForward).negate();
    this.twoHandRight.crossVectors(this.twoHandForward, this.worldUp);
    if (this.twoHandRight.lengthSq() < 0.0001) {
      return;
    }
    this.twoHandRight.normalize();
    this.twoHandUp.crossVectors(this.twoHandZ, this.twoHandRight).normalize();
    this.twoHandBasis.makeBasis(
      this.twoHandRight,
      this.twoHandUp,
      this.twoHandZ,
    );
    this.desiredQuaternion.setFromRotationMatrix(this.twoHandBasis);
    gunObject.getWorldQuaternion(this.gunQuaternion);
    runtime.correction
      .copy(this.gunQuaternion)
      .invert()
      .multiply(this.desiredQuaternion);
  }

  private isSupportHandActive(holder: string, runtime: GunRuntime): boolean {
    if (runtime.supportPoint == null) {
      return false;
    }
    const freeHand = holder === 'left' ? 'right' : 'left';
    // A magazine grab has priority over the SMG's custom support-hand pose.
    // Otherwise bringing the magazine to the well can rotate the front rail
    // toward the hand that is carrying it.
    if (this.isHandHoldingMagazine(freeHand)) {
      runtime.supportLatched = false;
      return false;
    }
    const squeezing =
      (this.input.xr.gamepads[freeHand]?.getButtonValue(InputComponent.Squeeze) ?? 0) >
      GRAB_THRESHOLD;
    const supportHand = this.player.gripSpaces[freeHand];
    supportHand.getWorldPosition(this.supportHandWorld);
    if (!squeezing) {
      runtime.supportLatched = false;
      return false;
    }
    if (runtime.supportLatched) {
      return true;
    }
    const squeezeStarted =
      this.input.xr.gamepads[freeHand]?.getButtonDown(InputComponent.Squeeze) === true;
    if (!squeezeStarted) {
      return false;
    }
    runtime.supportPoint.getWorldPosition(this.supportWorld);
    runtime.supportLatched =
      this.supportHandWorld.distanceToSquared(this.supportWorld) <=
      SMG_SUPPORT_RADIUS * SMG_SUPPORT_RADIUS;
    return runtime.supportLatched;
  }

  private isHandHoldingMagazine(hand: 'left' | 'right'): boolean {
    const grab = this.world.getSystem(GrabSystem);
    if (grab == null) {
      return false;
    }
    for (const magazine of this.queries.heldMagazines.entities) {
      if (grab.getHolderHand(magazine) === hand) {
        return true;
      }
    }
    return false;
  }

  private resetGunPose(gun: Entity): void {
    const runtime = this.gunRuntime.get(gun.index);
    if (runtime == null) {
      return;
    }
    runtime.correction.identity();
    if (runtime.aimFrame != null) {
      runtime.aimFrame.quaternion.identity();
      runtime.aimFrame.position.set(0, 0, 0);
    }
    runtime.supportLatched = false;
  }

  private gunState(gun: Entity, gunObject: Object3D): GunRuntime {
    let runtime = this.gunRuntime.get(gun.index);
    if (runtime == null) {
      runtime = {
        aimFrame: null,
        gripPoint: null,
        supportPoint: null,
        supportLatched: false,
        slide: null,
        muzzle: null,
        flash: null,
        tracer: null,
        magWell: null,
        magEject: null,
        rackZone: null,
        zoneMin: new Vector3(),
        zoneMax: new Vector3(),
        zoneReady: false,
        correction: new Quaternion(),
      };
      this.gunRuntime.set(gun.index, runtime);
    }
    runtime.aimFrame = runtime.aimFrame ?? gunObject.getObjectByName('Recoil') ?? null;
    runtime.gripPoint = runtime.gripPoint ?? gunObject.getObjectByName('GripPoint') ?? null;
    runtime.supportPoint =
      runtime.supportPoint ?? gunObject.getObjectByName('SupportGrip') ?? null;
    runtime.slide = runtime.slide ?? gunObject.getObjectByName('Slide') ?? null;
    runtime.muzzle = runtime.muzzle ?? gunObject.getObjectByName('Muzzle') ?? null;
    runtime.flash = runtime.flash ?? gunObject.getObjectByName('MuzzleFlash') ?? null;
    runtime.tracer = runtime.tracer ?? gunObject.getObjectByName('Tracer') ?? null;
    runtime.magWell = runtime.magWell ?? gunObject.getObjectByName('MagWell') ?? null;
    runtime.magEject = runtime.magEject ?? gunObject.getObjectByName('MagEject') ?? null;
    runtime.rackZone = runtime.rackZone ?? gunObject.getObjectByName('RackZone') ?? null;

    // Measure the authored rack zone once, in the frame the rack gesture is
    // compared against, so different weapon layouts need no hard-coded box.
    if (!runtime.zoneReady && runtime.rackZone instanceof Mesh) {
      const zone = runtime.rackZone;
      zone.updateMatrix();
      zone.geometry.computeBoundingBox();
      const box = zone.geometry.boundingBox;
      if (box != null) {
        runtime.zoneMin.copy(box.min).applyMatrix4(zone.matrix);
        runtime.zoneMax.copy(box.max).applyMatrix4(zone.matrix);
        // Keep the min/max corners ordered even if the zone is rotated.
        if (runtime.zoneMin.x > runtime.zoneMax.x) {
          const swap = runtime.zoneMin.x;
          runtime.zoneMin.x = runtime.zoneMax.x;
          runtime.zoneMax.x = swap;
        }
        if (runtime.zoneMin.y > runtime.zoneMax.y) {
          const swap = runtime.zoneMin.y;
          runtime.zoneMin.y = runtime.zoneMax.y;
          runtime.zoneMax.y = swap;
        }
        if (runtime.zoneMin.z > runtime.zoneMax.z) {
          const swap = runtime.zoneMin.z;
          runtime.zoneMin.z = runtime.zoneMax.z;
          runtime.zoneMax.z = swap;
        }
        runtime.zoneReady = true;
      }
    }
    return runtime;
  }
}
