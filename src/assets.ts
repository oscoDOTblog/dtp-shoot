/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import { createPistol } from './scene-assets/pistol.scene-asset.js';
import { createRangeBench } from './scene-assets/range-bench.scene-asset.js';
import { createRangeBerm } from './scene-assets/range-berm.scene-asset.js';
import { createRangeFloor } from './scene-assets/range-floor.scene-asset.js';
import { createTarget } from './scene-assets/target.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

const uikitml = (fileName: string, name: string) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

export default defineAssets({
  'range-floor': createRangeFloor(),
  pistol: createPistol(),
  target: createTarget(),
  'range-bench': createRangeBench(),
  'range-berm': createRangeBerm(),
  'range-hud': uikitml('range-hud.uikitml', 'Range HUD'),
});
