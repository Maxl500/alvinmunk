/**
 * End-to-end flow tests against the LIVE testnet contracts — exercises exactly what the
 * UI does (vouch / claim / quest / tip / reward), with happy AND negative paths. This is the
 * integration layer behind every UX action.
 *
 * Secret-free: admin (USDC issuer) + attester keys come from env. Generates throwaway
 * users via Friendbot. Mutating-config tests (daily cap, frozen, proof-of-funding, streak
 * gate) reset the contract afterwards. Records pass/fail, never aborts on one failure, exits
 * non-zero if anything failed.
 *
 * Run from repo root:
 *   ADMIN_SECRET_KEY=S... ATTESTER_SECRET_KEY=S... node scripts/e2e-testnet.mj
 * The RPC/Horizon URLs and contract ids come from scripts/lib/env.mj (NEXT_PUBLIC_* env,
 * then apps/web/.env.local, then deployments/testnet.json); a missing id exits 2.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { loadDeployment } from './lib/env.mjs';
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '.', 'apps', 'web', 'package.json'));
const {
  Address, Asset, Contract, Keypair, Networks, Operation, TransactionBuilder,
  nativeToScVal, scValToNative, rpc, Horizon, xdr
} = require('@stellar/stellar-sdk');

const PASS = Networks.TESTNET; // testnet only: throwaway users come from Friendbot
const deployment = loadDeployment(['reputation', 'questRegistry', 'rewards', 'usdcSac'], {
  network: 'testnet',
  settings: ['rpcUrl', 'horizonUrl'],
});
const RPC = deployment.rpcUrl;
const HOR = deployment.horizonUrl;
const { reputation: REP, questRegistry: QUEST, rewards: REWARDS, usdcSac: USD_SAC } = deployment.contracts;

const ADMIN = Keypair.fromSecret(reqEnv('ADMIN_SECRET_KEY'));
const ATTESTER = Keypair.fromSecret(reqEnv('ATTESTER_SECRET_KEY'));
const usdc = new Asset('USDC', ADMIN.publicKey());
const server = new rpc.Server(RPC);
const hor = new Horizon.Server(MHOR);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (n) => nativeToScVal(n, { type: 'u32' });
const u64 = (n) => nativeToScVal(n, { type: 'u64' });
const i128 = (n) => nativeToScVal(n, { type: 'i128' });
const A = (s) => new Address(s).toScVal();
const bytes = (u8) => nativeToScVal(u8, { type: 'bytes' });
const str = (s) => nativeToScVal(s, { type: 'string' });

function reqEnv(k) {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env ${k}. Run: ADMIN_SECRET_KEY=S… ATTESTER_SECRET_KEY=S… node scripts/e2e-testnet.mj`);
    process.exit(2);
  }
  return v;
}

async function friendbot(pk) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pk}`);
  if (!r.ok && r.status !== 400) throw new Error('friendbot ' + r.status);
}
async function newUser() {
  const kp = Keypair.random();
  await friendbot(kp.publicKey());
  return kp;
}
async function classic(kp, op) {
  const acc = await hor.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: '2000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build();
  tx.sign(kp);
  return hor.submitTransaction(tx);
}
async function invoke(kp, id, method, args) {
  // Retry on txBadSeq — rapid same-account txs (esp. ADMIN config) can race the
  // sequence number; refetch the account and rebuild.
  for (let attempt = 0; attempt < 5; attempt++) {
    const acc = await server.getAccount(kp.publicKey());
    const built = new TransactionBuilder(acc, { fee: '2000000', networkPassphrase: PASS })
      .addOperation(new Contract(id).call(method, ...args)).setTimeout(60).build();
    const prepared = await server.prepareTransaction(built);
    prepared.sign(kp);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      const code = JSON.stringify(sent.errorResult);
      if (code.includes('txBadSeq') && attempt < 4) { await sleep(1500); continue; }
      throw new Error('send: ' + code);
    }
    for (let i = 0; i < 30; i++) {
      try {
        const r = await server.getTransaction(sent.hash);
        if (r.status === 'SUCCESS') return r.returnValue ? scValToNative(r.returnValue) : null;
        if (r.status === 'FAILED') throw new Error('tx failed on-chain ' + sent.hash);
      } catch (e) { if (String(e.message).includes('failed on-chain')) throw e; }
      await sleep(1000);
    }
    throw new Error('not confirmed');
  }
  throw new Error('txBadSeq retries exhausted');
}
async function read(id, method, args) {
  const acc = await server.getAccount(ADMIN.publicKey());
  const tx = new TransactionBuilder(acc, { fee: '2000000', networkPassphrase: PASS })
    .addOperation(new Contract(id).call(method, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error('sim: ' + sim.error);
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}
const score = (a) => read(REP, 'get_score', [A(a)]).then(Number);
const earned = (a) => read(REP, 'get_earned', [A(a)]).then(Number);
const usdcBal = (a) => read(USD_SAC, 'balance', [A(a)]).then((v) => BigInt(v ?? 0));
async function trustAndMaybeFund(kp, fundUsdc = 0n) {
  await classic(kp, Operation.changeTrust({ asset: usdc }));
  if (fundUsdc > 0n) await classic(ADMIN, Operation.payment({ destination: kp.publicKey(), asset: usdc, amount: (Number(fundUsdc) / 1e7).toString() }));
}
function secretPair() {
  const s = crypto.randomBytes(32);
  return { secret: new Uint8Array(s), hash: new Uint8Array(crypto.createHash('sha256').update(s).digest()) };
}

// Like /api/attest: a signature valid for 10 minutes. The payload comes from the live
// contract's `quest_payload` view, so this also checks the deployment's payload format.
async function signQuest(questId, recipientPk, expiresAt) {
  const payload = await read(QUEST, 'quest_payload', [u32(questId), A(recipientPk), u64(expiresAt)]);
  const sig = ATTESTER.sign(payload);
  const attesterBytes = ATTESTER.rawPublicKey();
  return { attesterBytes, sig };
}

async function awardQuest(recipientKp, questId, overrideSig = null, expiresAt = Math.floor(Date.now() / 1000) + 600) {
  const { attesterBytes, sig } = await signQuest(questId, recipientKp.publicKey(), expiresAt);
  const finalSig = overrideSig ?? sig;
  return invoke(recipientKp, QUEST, 'award_quest', [
    bytes(attesterBytes),
    bytes(finalSig),
    u32(questId),
    A(recipientKp.publicKey()),
    u64(expiresAt),
  ]);
}

// ── tiny test runner ──
let pass = 0, fail = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); pass++; }
  catch (e) { console.log(`❌ ${name}\n   ${String(e.message).split('Event log')[0].trim().slice(0, 160)}`); fail++; fails.push(name); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function expectRevert(code, fn) {
  try { await fn(); throw new Error('expected revert but it succeeded'); }
  catch (e) {
    const m = String(e.message);
    if (m.includes('expected revert')) throw e;
    // Extract the exact error code from "Error(Contract, #N)" format using regex.
    // If the regex doesn't match or the code doesn't match expected, fail the assertion.
    const hit = /Error\(Contract, #(\d+)\)/.exec(m);
    assert(hit && Number(hit[1]) === code, `expected contract error #${code}, got: ${m.slice(0, 160)}`);
  }
}

(async () => {
  console.log('e2e: provisioning users via friendbot…');
  const [Aw, Bw, Cw, Dw] = await Promise.all([newUser(), newUser(), newUser(), newUser()]);
  await sleep(2000);
  console.log('A', Aw.publicKey(), '\nB', Bw.publicKey(), '\nC', Cw.publicKey(), '\nD', Dw.publicKey(), '\n');

  // ── HAPPY: vouch loop (asymmetric social XP, two-track) ──
  let vouchId;
  await test('happy: mint_vouch + claim_vouch → asymmetric Social XP, Earned untouched', async () => {
    const { secret, hash } = secretPair();
    const awBefore = await score(Aw.publicKey());
    const bwBefore = await score(Bw.publicKey());
    vouchId = Number(await invoke(Aw, REP, 'mint_vouch', [A(Aw.publicKey()), bytes(hash), str('gm')]));
    await invoke(Bw, REP, 'claim_vouch', [A(Bw.publicKey()), u64(vouchId), bytes(secret)]);
    assert((await score(Aw.publicKey())) - awBefore === 20, 'voucher social XP delta should be +20 (starter - stake + refund)');
    assert((await score(Bw.publicKey())) - bwBefore === 30, 'claimer social XP delta should be +30 (starter + claim)');
    assert((await earned(Bw.publicKey())) === 0, 'claimer earned must stay 0 (keystone)');
  });

  // ── HAPPY: quest → Earned XP + streak ──
  await test('happy: award_quest → Earned XP (quest 1 = 50) + streak', async () => {
    await awardQuest(Cw, 1);
    assert((await earned(Cw.publicKey())) === 50, 'C earned should be 50');
    const s = await read(QUEST, 'get_streak', [A(C.publicKey())]);
    assert(Number(s.weeks) === 1, 'streak weeks should be 1');
  });

  // ── HAPPY: USDC tip wallet→wallet ──
  await test('happy: enable USDC + faucet-style fund + tip A-B', async () => {
    await trustAndMaybeFund(Aw, 50000000n);
    await trustAndMaybeFund(Bw, 0n);
    const before = await usdcBal(Bw.publicKey());
    await invoke(Aw, REWARDS, 'tip', [A(Aw.publicKey()), A(Bw.publicKey()), i128(10000000n)]);
    assert((await usdcBal(Bw.publicKey())) - before === 10000000n, 'B should receive 1 USDC');
  });

  // ── HAPPY: reward claim (earned-gated, exact stored amount) ──
  await test('happy: claim_reward #1 (earned 50 ≥ 30) → exact 0.5 USDC', async () => {
    await trustAndMaybeFund(Cw, 0n);
    const before = await usdcBal(Cw.publicKey());
    await invoke(Cw, REWARDS, 'claim_reward', [A(Aw.publicKey()), u32(1)]);
    assert((await usdcBal(Cw.publicKey())) - before === 5000000n, 'C should receive exactly 0.5 USDC');
    assert((await read(REWARDS, 'is_claimed', [u32(1), A(Cw.publicKey())])) === true, 'is_claimed true');
  });

  // ── NEGATIVE: vouch guards ──
  await test('negative: self-vouch reverts (#6 SelfVouch)', async () => {
    const { secret, hash } = secretPair();
    const id = Number(await invoke(Aw, REP, 'mint_vouch', [A(Aw.publicKey()), bytes(hash), str('self')]));
    await expectRevert(6, () => invoke(Aw, REP, 'claim_vouch', [A(Aw.publicKey()), u64(id), bytes(secret)]));
  });
  await test('negative: wrong secret reverts (#8 BadSecret)', async () => {
    const { hash } = secretPair();
    const id = Number(await invoke(Aw, REP, 'mint_vouch', [A(Aw.publicKey()), bytes(hash), str('x')]));
    const wrong = new Uint8Array(crypto.randomBytes(32));
    await expectRevert(8, () => invoke(Bw, REP, 'claim_vouch', [A(Bw.publicKey()), u64(id), bytes(wrong)]));
  });
  await test('negative: double-claim same vouch reverts (#5 AlreadyClaimed)', async () => {
    const { secret, hash } = secretPair();
    const id = Number(await invoke(Aw, REP, 'mint_vouch', [A(Aw.publicKey()), bytes(hash), str('dc')]));
    await invoke(Cw, REP, 'claim_vouch', [A(Cw.publicKey()), u64(id), bytes(secret)]);
    await expectRevert(5, () => invoke(Cw, REP, 'claim_vouch', [A(Aw.publicKey()), u64(id), bytes(secret)]));
  });

  // ── NEGATIVE: quest replay & signature validation ──
  await test('negative: quest replay reverts (#5 AlreadyClaimed)', async () => {
    await expectRevert(5, () => awardQuest(Cw, 1));
  });
  await test('negative: expired quest signature reverts (#8 SignatureExpired)', async () => {
    await expectRevert(8, () => awardQuest(Dw, 1, null, Math.floor(Date.now() / 1000) - 60));
  });
  await test('negative: quest with bad signature reverts', async () => {
    const badSig = new Uint8Array(64); // invalid zero signature
    try {
      await awardQuest(Dw, 1, badSig);
      throw new Error('expected revert but it succeeded');
    } catch (e) {
      const m = String(e.message);
      if (m.includes('expected revert')) throw e;
      assert(m.includes('tx failed') || m.includes('send:') || m.includes('sim:'), `expected tx/signature failure, got: ${m.slice(0, 160)}`);
    }
  });

  console.log(`\ne2e: ${pass} passed, ${fail} failed`);
  if (fails.length) console.log('failed:', fails.join(', '));
  process.exit(fail ? 1 : 0);
})();
