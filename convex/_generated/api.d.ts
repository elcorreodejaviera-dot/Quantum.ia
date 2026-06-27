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
import type * as admin from "../admin.js";
import type * as adminLive from "../adminLive.js";
import type * as bots from "../bots.js";
import type * as bugReports from "../bugReports.js";
import type * as cloids from "../cloids.js";
import type * as coverageUsage from "../coverageUsage.js";
import type * as cronHealth from "../cronHealth.js";
import type * as crons from "../crons.js";
import type * as engineEvents from "../engineEvents.js";
import type * as executions from "../executions.js";
import type * as executionsCron from "../executionsCron.js";
import type * as helpers from "../helpers.js";
import type * as hlCredentialActions from "../hlCredentialActions.js";
import type * as hlCredentials from "../hlCredentials.js";
import type * as hlNetwork from "../hlNetwork.js";
import type * as hyperliquid from "../hyperliquid.js";
import type * as hyperliquidSpot from "../hyperliquidSpot.js";
import type * as leverage from "../leverage.js";
import type * as log from "../log.js";
import type * as migrations from "../migrations.js";
import type * as plans from "../plans.js";
import type * as pools from "../pools.js";
import type * as seed from "../seed.js";
import type * as spotDefenseBots from "../spotDefenseBots.js";
import type * as spotDefenseEngine from "../spotDefenseEngine.js";
import type * as spotGridActions from "../spotGridActions.js";
import type * as spotGridBots from "../spotGridBots.js";
import type * as spotGridConstants from "../spotGridConstants.js";
import type * as spotGridEngine from "../spotGridEngine.js";
import type * as spot_positions from "../spot_positions.js";
import type * as subscriptions from "../subscriptions.js";
import type * as systemConfig from "../systemConfig.js";
import type * as tradesHistory from "../tradesHistory.js";
import type * as triggerArms from "../triggerArms.js";
import type * as triggerEngine from "../triggerEngine.js";
import type * as triggerRearm from "../triggerRearm.js";
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
  admin: typeof admin;
  adminLive: typeof adminLive;
  bots: typeof bots;
  bugReports: typeof bugReports;
  cloids: typeof cloids;
  coverageUsage: typeof coverageUsage;
  cronHealth: typeof cronHealth;
  crons: typeof crons;
  engineEvents: typeof engineEvents;
  executions: typeof executions;
  executionsCron: typeof executionsCron;
  helpers: typeof helpers;
  hlCredentialActions: typeof hlCredentialActions;
  hlCredentials: typeof hlCredentials;
  hlNetwork: typeof hlNetwork;
  hyperliquid: typeof hyperliquid;
  hyperliquidSpot: typeof hyperliquidSpot;
  leverage: typeof leverage;
  log: typeof log;
  migrations: typeof migrations;
  plans: typeof plans;
  pools: typeof pools;
  seed: typeof seed;
  spotDefenseBots: typeof spotDefenseBots;
  spotDefenseEngine: typeof spotDefenseEngine;
  spotGridActions: typeof spotGridActions;
  spotGridBots: typeof spotGridBots;
  spotGridConstants: typeof spotGridConstants;
  spotGridEngine: typeof spotGridEngine;
  spot_positions: typeof spot_positions;
  subscriptions: typeof subscriptions;
  systemConfig: typeof systemConfig;
  tradesHistory: typeof tradesHistory;
  triggerArms: typeof triggerArms;
  triggerEngine: typeof triggerEngine;
  triggerRearm: typeof triggerRearm;
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
