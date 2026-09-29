/**
 * Blue anti-abuse — off-chain ring/cluster detector → on-chain `frozen` set.
 *
 * Reads the Reputation `vouch/claimed` events from RPC, builds (from→claimer) pairs,
 * flags ring candidates (reciprocal A↔B pairs and A→B→C→A cycles), and calls
 * `Rewards.set_frozen(addr, true)` so the contract blocks those accounts from claim/tip.
 * The on-chain hook shipped with the Green rewards-hardening pass; this is the off-chain
 * brain that drives it.
 *
 * Secret-free: the admin key is read from $ADMIN_SECRET_KEY (never committed).
 * Dry-run by default — set APPLY=1 to actually freeze.
 *
 * Run from apps/web:  ADMIN_SECRET_KEY=S... [APPLY=1] node ../../scripts/freeze-rings.mjs
 */
// stellar-sdk lives in apps/web/node_modules (pnpm, no root hoist) — resolve from there.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDeployment } from './lib/env.mjs';
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '.', 'apps', 'web', 'package.json'));
const {
  Address, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal, scValToNative, rpc, xdr,
} = require('@stellar/stellar-sdk');

const { networkPassphrase, rpcUrl, ids: { reputation, rewards } } = loadDeployment();
const REPUTATION = reputation;
const REWARDS = rewards;

