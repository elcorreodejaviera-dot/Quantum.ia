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
import type * as actions_poolScanner from "../actions/poolScanner.js";
import type * as actions_uniswap from "../actions/uniswap.js";
import type * as alerts from "../alerts.js";
import type * as bots from "../bots.js";
import type * as crons from "../crons.js";
import type * as executionLimits from "../executionLimits.js";
import type * as executions from "../executions.js";
import type * as executionsCron from "../executionsCron.js";
import type * as helpers from "../helpers.js";
import type * as hlCredentialActions from "../hlCredentialActions.js";
import type * as hlCredentials from "../hlCredentials.js";
import type * as hlNetwork from "../hlNetwork.js";
import type * as hyperliquid from "../hyperliquid.js";
import type * as migrations from "../migrations.js";
import type * as pools from "../pools.js";
import type * as seed from "../seed.js";
import type * as spot_positions from "../spot_positions.js";
import type * as systemConfig from "../systemConfig.js";
import type * as tradesHistory from "../tradesHistory.js";
import type * as users from "../users.js";
import type * as wallets from "../wallets.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actions/defillama": typeof actions_defillama;
  "actions/poolScanner": typeof actions_poolScanner;
  "actions/uniswap": typeof actions_uniswap;
  alerts: typeof alerts;
  bots: typeof bots;
  crons: typeof crons;
  executionLimits: typeof executionLimits;
  executions: typeof executions;
  executionsCron: typeof executionsCron;
  helpers: typeof helpers;
  hlCredentialActions: typeof hlCredentialActions;
  hlCredentials: typeof hlCredentials;
  hlNetwork: typeof hlNetwork;
  hyperliquid: typeof hyperliquid;
  migrations: typeof migrations;
  pools: typeof pools;
  seed: typeof seed;
  spot_positions: typeof spot_positions;
  systemConfig: typeof systemConfig;
  tradesHistory: typeof tradesHistory;
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
