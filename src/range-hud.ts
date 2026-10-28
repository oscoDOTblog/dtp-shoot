/**
 * DTP Shoot — range HUD binding.
 *
 * Reads the singleton RangeGame state and mirrors it into the UIKitML panel.
 * Element lookups are retried until the panel instance is live, then wired once.
 */

import {
  UIKitMLAsset,
  UIKit,
  VisibilityState,
  createSystem,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  AmmoMode,
  Gun,
  MAGAZINE_MAX,
  MAGAZINE_MIN,
  RangeGame,
} from './range-components.js';

const TIME_LOW_COLOR = '#ff8a5a';
const TIME_COLOR = '#fafaf7';
const STATUS_DONE_COLOR = '#f5d90a';
const STATUS_COLOR = '#f2f2ee';
const AMMO_LOW_LABEL = 'MAG LOW';
const AMMO_UNLIMITED_LABEL = 'UNLIMITED AMMO';

export class RangeHudSystem extends createSystem({
  game: { required: [RangeGame] },
  guns: { required: [Gun] },
}) {
  private connected = false;
  private ammoConnected = false;
  private scoreText: UIKit.Text | null = null;
  private timeText: UIKit.Text | null = null;
  private statsText: UIKit.Text | null = null;
  private statusText: UIKit.Text | null = null;
  private playAgain: UIKit.Text | null = null;
  private ammoValue: UIKit.Text | null = null;
  private ammoHint: UIKit.Text | null = null;
  private ammoAlert: UIKit.Text | null = null;
  private modeUnlimited: UIKit.Text | null = null;
  private modeReloading: UIKit.Text | null = null;
  private sizeRow: UIKit.Text | null = null;
  private sizeValue: UIKit.Text | null = null;

  private lastScore = Number.NaN;
  private lastTime = Number.NaN;
  private lastStats = '';
  private lastStatus = '';
  private lastFinished: boolean | null = null;
  private lastLowTime: boolean | null = null;
  private lastAmmoSignature = '';

  update(): void {
    if (!this.connected) {
      this.connect();
    }
    if (!this.ammoConnected) {
      this.connectAmmo();
    }
    const game = this.gameEntity();
    if (game == null) {
      return;
    }

    this.updateAmmo(game);

    if (this.scoreText != null) {
      const score = game.getValue(RangeGame, 'score') ?? 0;
      if (score !== this.lastScore) {
        this.lastScore = score;
        this.scoreText.setProperties({ text: String(score) });
      }
    }

    if (this.timeText != null) {
      const seconds = Math.max(
        0,
        Math.ceil(game.getValue(RangeGame, 'timeLeft') ?? 0),
      );
      if (seconds !== this.lastTime) {
        this.lastTime = seconds;
        this.timeText.setProperties({ text: String(seconds) });
        const low = seconds <= 10;
        if (low !== this.lastLowTime) {
          this.lastLowTime = low;
          this.timeText.setProperties({ color: low ? TIME_LOW_COLOR : TIME_COLOR });
        }
      }
    }

    if (this.statsText != null) {
      const hits = game.getValue(RangeGame, 'hits') ?? 0;
      const shots = game.getValue(RangeGame, 'shots') ?? 0;
      const accuracy = shots > 0 ? Math.round((hits / shots) * 100) : 0;
      const text = `HITS ${hits} / ${shots} - ${accuracy}%`;
      if (text !== this.lastStats) {
        this.lastStats = text;
        this.statsText.setProperties({ text });
      }
    }

    if (this.statusText != null) {
      const status = game.getValue(RangeGame, 'status') ?? '';
      if (status !== this.lastStatus) {
        this.lastStatus = status;
        this.statusText.setProperties({ text: status });
      }
    }

    const finished = game.getValue(RangeGame, 'finished') === true;
    if (finished !== this.lastFinished) {
      this.lastFinished = finished;
      this.playAgain?.setProperties({ display: finished ? 'flex' : 'none' });
      this.statusText?.setProperties({
        color: finished ? STATUS_DONE_COLOR : STATUS_COLOR,
      });
    }
  }

  private gameEntity(): Entity | null {
    for (const entity of this.queries.game.entities) {
      return entity;
    }
    return null;
  }

  private firstGun(): Entity | null {
    for (const gun of this.queries.guns.entities) {
      return gun;
    }
    return null;
  }

  /** Mirrors the pistol's magazine state and the bench settings into the panel. */
  private updateAmmo(game: Entity): void {
    if (this.ammoValue == null) {
      return;
    }
    const gun = this.firstGun();
    if (gun == null) {
      return;
    }
    const unlimited =
      (game.getValue(RangeGame, 'ammoMode') ?? AmmoMode.Reloading) ===
      AmmoMode.Unlimited;
    const size = game.getValue(RangeGame, 'magazineSize') ?? 8;
    const ammo = gun.getValue(Gun, 'ammo') ?? 0;
    const hasMag = gun.getValue(Gun, 'magIn') !== false;
    const needsRack = gun.getValue(Gun, 'needsRack') === true;
    const signature = `${unlimited}|${size}|${ammo}|${hasMag}|${needsRack}`;
    if (signature === this.lastAmmoSignature) {
      return;
    }
    this.lastAmmoSignature = signature;

    this.ammoValue.setProperties({
      // The runtime font atlas has no infinity glyph, so "MAX" carries it.
      text: unlimited ? 'MAX' : `${ammo} / ${size}`,
    });

    const alert = unlimited
      ? ''
      : !hasMag
        ? 'GRAB A SPARE MAG'
        : ammo <= 0
          ? 'PRESS A TO DROP MAG'
          : needsRack
            ? 'RACK THE SLIDE'
            : '';
    this.ammoHint?.setProperties({
      text: unlimited
        ? AMMO_UNLIMITED_LABEL
        : ammo <= 2
          ? AMMO_LOW_LABEL
          : 'READY',
      display: alert === '' ? 'flex' : 'none',
    });
    this.ammoAlert?.setProperties({
      text: alert,
      display: alert === '' ? 'none' : 'flex',
    });

    this.setModeActive(this.modeUnlimited, unlimited);
    this.setModeActive(this.modeReloading, !unlimited);
    this.sizeRow?.setProperties({ display: unlimited ? 'none' : 'flex' });
    this.sizeValue?.setProperties({ text: String(size) });
  }

  /** Toggling a class avoids fighting the dark-scheme rules with inline styles. */
  private setModeActive(element: UIKit.Text | null, active: boolean): void {
    if (element == null) {
      return;
    }
    const has = element.classList.contains('mode-on');
    if (active && !has) {
      element.classList.add('mode-on');
    } else if (!active && has) {
      element.classList.remove('mode-on');
    }
  }

  private connectAmmo(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('ammo-panel');
    if (panel == null) {
      return;
    }
    const value = panel.getElementById<UIKit.Text>('ammo-value');
    if (value == null) {
      return;
    }
    this.ammoValue = value;
    this.ammoHint = panel.getElementById<UIKit.Text>('ammo-hint') ?? null;
    this.ammoAlert = panel.getElementById<UIKit.Text>('ammo-alert') ?? null;
    this.modeUnlimited =
      panel.getElementById<UIKit.Text>('mode-unlimited') ?? null;
    this.modeReloading =
      panel.getElementById<UIKit.Text>('mode-reloading') ?? null;
    this.sizeRow = panel.getElementById<UIKit.Text>('mag-size-row') ?? null;
    this.sizeValue =
      panel.getElementById<UIKit.Text>('mag-size-value') ?? null;
    value.name = 'AmmoValue';
    if (this.ammoHint != null) this.ammoHint.name = 'AmmoHint';
    if (this.ammoAlert != null) this.ammoAlert.name = 'AmmoAlert';
    this.lastAmmoSignature = '';

    const setMode = (mode: string) => {
      this.gameEntity()?.setValue(RangeGame, 'ammoMode', mode);
    };
    const stepSize = (step: number) => {
      const game = this.gameEntity();
      if (game == null) {
        return;
      }
      const size = game.getValue(RangeGame, 'magazineSize') ?? 8;
      game.setValue(
        RangeGame,
        'magazineSize',
        Math.min(MAGAZINE_MAX, Math.max(MAGAZINE_MIN, size + step)),
      );
    };

    const unlimited = () => setMode(AmmoMode.Unlimited);
    const reloading = () => setMode(AmmoMode.Reloading);
    const smaller = () => stepSize(-1);
    const larger = () => stepSize(1);
    this.modeUnlimited?.addEventListener('click', unlimited);
    this.modeReloading?.addEventListener('click', reloading);
    panel.getElementById('mag-minus')?.addEventListener('click', smaller);
    panel.getElementById('mag-plus')?.addEventListener('click', larger);
    this.cleanupFuncs.push(
      () => this.modeUnlimited?.removeEventListener('click', unlimited),
      () => this.modeReloading?.removeEventListener('click', reloading),
      () => panel.getElementById('mag-minus')?.removeEventListener('click', smaller),
      () => panel.getElementById('mag-plus')?.removeEventListener('click', larger),
    );

    this.ammoConnected = true;
  }

  private connect(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('range-hud-panel');
    if (panel == null) {
      return;
    }

    this.scoreText = panel.getElementById<UIKit.Text>('score-value') ?? null;
    this.timeText = panel.getElementById<UIKit.Text>('time-value') ?? null;
    this.statsText = panel.getElementById<UIKit.Text>('stats-text') ?? null;
    this.statusText = panel.getElementById<UIKit.Text>('status-text') ?? null;
    this.playAgain = panel.getElementById<UIKit.Text>('play-again') ?? null;

    if (this.scoreText != null) this.scoreText.name = 'ScoreValue';
    if (this.timeText != null) this.timeText.name = 'TimeValue';
    if (this.statsText != null) this.statsText.name = 'StatsText';
    if (this.statusText != null) this.statusText.name = 'StatusText';
    if (this.playAgain != null) this.playAgain.name = 'PlayAgain';

    const requestRestart = () => {
      const game = this.gameEntity();
      game?.setValue(RangeGame, 'restartRequested', true);
    };
    this.playAgain?.addEventListener('click', requestRestart);
    this.cleanupFuncs.push(() => {
      this.playAgain?.removeEventListener('click', requestRestart);
    });

    this.connectXrButtons(panel);
    this.connected = true;
  }

  private connectXrButtons(panel: UIKitMLAsset): void {
    const xrButton = panel.getElementById('xr-button');
    const exitButton = panel.getElementById('exit-button');
    if (xrButton == null || exitButton == null) {
      return;
    }

    if (!this.world.xrEnabled) {
      xrButton.setProperties({ display: 'none' });
      exitButton.setProperties({ display: 'none' });
      return;
    }

    const launchXR = () => this.world.launchXR();
    const exitXR = () => this.world.exitXR();
    xrButton.addEventListener('click', launchXR);
    exitButton.addEventListener('click', exitXR);

    this.cleanupFuncs.push(
      () => xrButton.removeEventListener('click', launchXR),
      () => exitButton.removeEventListener('click', exitXR),
      this.world.visibilityState.subscribe((visibilityState) => {
        const is2D = visibilityState === VisibilityState.NonImmersive;
        xrButton.setProperties({ display: is2D ? 'flex' : 'none' });
        exitButton.setProperties({ display: is2D ? 'none' : 'flex' });
      }),
    );
  }
}
