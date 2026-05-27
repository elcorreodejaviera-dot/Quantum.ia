/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions_defillama from "../actions/defillama.js";
import type * as bots from "../bots.js";
import type * as crons from "../crons.js";
import type * as helpers from "../helpers.js";
import type * as pools from "../pools.js";
import type * as seed from "../seed.js";
import type * as spot_positions from "../spot_positions.js";
import type * as systemConfig from "../systemConfig.js";
import type * as users from "../users.js";
import type * as wallets from "../wallets.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actions/defillama": typeof actions_defillama;
  bots: typeof bots;
  crons: typeof crons;
  helpers: typeof helpers;
  pools: typeof pools;
  seed: typeof seed;
  spot_positions: typeof spot_positions;
  systemConfig: typeof systemConfig;
  users: typeof users;
  wallets: typeof wallets;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
