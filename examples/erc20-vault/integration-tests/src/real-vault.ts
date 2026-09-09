import { CompactTypeBytes } from "@midnight-ntwrk/compact-runtime";
import { SucceedEntirely } from "@midnight-ntwrk/midnight-js/types";
import {
  type IndexerPublicDataProvider,
  indexerPublicDataProvider,
} from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  ContractState,
  signatureVerifyingKey,
  signingKeyFromBip340,
} from "@midnightntwrk/ledger-v9";
import {
  contractAddressFromHex,
  hexToBytes,
  parseRequestIdHex,
  type RawContractState,
  requestIdBytes,
  signetFieldNodeByPath,
} from "@sig-net/midnight";
import { getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";
import { expectedVk, readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";
import { readDeferredCircuits } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { installedCircuitIds } from "@sig-net/midnight-examples-lib";
import { configureRealMpc, requireEnv } from "@sig-net/midnight-examples-test-harness";

import { resolveUserIdentity } from "./vault-identity.ts";

/**
 * Check the vault's sealed constructor bindings against this run's singleton and identity.
 * The compiler's contract-info.json places SignetSigner at [0,1] and Bytes<32> deployer at
 * [1,2]; generated ContractAddress and Bytes<32> both encode one 32-byte atom.
 *
 * @param raw - Actual raw vault state from the indexer or compiled constructor.
 * @param singletonHex - The configured external Signet contract address.
 * @param commitment - User identity commitment sealed by the real deployment.
 * @throws {Error} If either sealed field differs or its storage shape is invalid.
 */
export function assertRealVaultBindings(
  raw: RawContractState,
  singletonHex: string,
  commitment: Uint8Array,
): void {
  const bytes32 = new CompactTypeBytes(32);
  for (const [name, path, expected] of [
    ["signetSigner", [0, 1], contractAddressFromHex(singletonHex).bytes],
    ["deployer", [1, 2], commitment],
  ] as const) {
    const cell = signetFieldNodeByPath(raw, path).asCell();
    const atoms = [...cell.value];
    const actual = bytes32.fromValue(atoms);
    if (
      atoms.length !== 0 ||
      actual.length !== expected.length ||
      actual.some((byte, index) => byte !== expected[index])
    ) {
      throw new Error(`vault ${name} does not match this real run`);
    }
  }
}

/**
 * Admit only fresh, pending, or confirmed-consumed request checkpoints.
 * A settlement marker is a reservation until the caller verifies its transaction on chain.
 *
 * @param env - Private checkpoint environment.
 * @param requestEnvKey - Field recording the immutable request ID.
 * @param settlementEnvKey - Field recording its settlement transaction ID.
 * @param requestPresent - Whether the corresponding request record exists on chain.
 * @param pendingPresent - Whether its settlement view exists on chain.
 * @throws {Error} If the checkpoint and the two records require manual reconciliation.
 */
export function assertRealRequestCheckpoint(
  env: NodeJS.ProcessEnv,
  requestEnvKey: string,
  settlementEnvKey: string,
  requestPresent: boolean,
  pendingPresent: boolean,
): void {
  const requestId = env[requestEnvKey];
  const settledTx = env[settlementEnvKey];
  if (requestId === undefined && settledTx === undefined && !requestPresent && !pendingPresent)
    return;
  if (requestId !== undefined) {
    try {
      parseRequestIdHex(requestId);
    } catch (error) {
      throw new Error(`reconcile ${requestEnvKey}: invalid saved request ID`, { cause: error });
    }
    if (requestPresent && pendingPresent && settledTx === undefined) return;
    if (
      !requestPresent &&
      !pendingPresent &&
      settledTx !== undefined &&
      /^[0-9a-fA-F]{64}$/.test(settledTx)
    )
      return;
  }
  throw new Error(
    `reconcile ${requestEnvKey} and ${settlementEnvKey} against the vault before continuing`,
  );
}

async function withVaultIndexer<T>(
  env: NodeJS.ProcessEnv,
  read: (provider: IndexerPublicDataProvider) => Promise<T>,
): Promise<T> {
  configureRealMpc(env);
  const node = getMidnightNodeConfig(env);
  const provider = indexerPublicDataProvider({
    queryURL: node.indexerUrl,
    subscriptionURL: node.indexerWsUrl,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(provider),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("reconcile real vault: indexer verification timed out after 30000ms"));
        }, 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await provider.dispose();
  }
}

/**
 * Verify the existing vault before resuming maintenance or user requests.
 * Missing circuits are permitted for a partial deployment; every installed circuit must match.
 *
 * @param env - Validated real configuration, vault address and private maintenance key.
 * @returns The verified installed circuit IDs; callers require completeness after resume.
 * @throws {Error} If compilation, bindings, maintenance authority, verifier bytes or reads fail.
 */
export async function verifyRealVault(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  if (Object.keys(expectedVk).length === 0)
    throw new Error("compile:erc20-vault:zk is required before real vault verification");
  return withVaultIndexer(env, async (provider) => {
    const address = requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
    const state = await provider.queryContractState(address);
    if (state === null)
      throw new Error(`real vault ${address} is absent; reconcile the prepared deployment`);
    assertRealVaultBindings(
      state.data,
      requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS"),
      resolveUserIdentity(env).commitment,
    );
    const keyHex = requireEnv(env, "MAINTENANCE_SIGNING_KEY").trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex))
      throw new Error("MAINTENANCE_SIGNING_KEY must be a 32-byte BIP-340 key");
    const expectedAuthority = signatureVerifyingKey(signingKeyFromBip340(hexToBytes(keyHex)));
    const serialized = state.serialize();
    const authority = ContractState.deserialize(serialized).maintenanceAuthority;
    const member = authority.committee.at(0);
    if (
      authority.threshold !== 1 ||
      authority.committee.length !== 1 ||
      member?.tag !== expectedAuthority.tag ||
      member.value !== expectedAuthority.value
    ) {
      throw new Error("real vault maintenance authority does not match this run");
    }
    const installed = installedCircuitIds(serialized);
    if (installed.some((id) => !Object.hasOwn(expectedVk, id)))
      throw new Error("real vault has an unknown installed operation");
    for (const { circuitId, verifierKey } of readDeferredCircuits(installed)) {
      const operation = state.operation(circuitId);
      if (operation === undefined || !Buffer.from(operation.verifierKey).equals(verifierKey))
        throw new Error(`real vault verifier key differs from this compile: ${circuitId}`);
    }
    return installed;
  });
}

/**
 * Reconcile saved deposit and withdrawal checkpoints with current records and confirmed settlement.
 * Indexer confirmation must report SucceedEntirely for the recorded transaction; record absence
 * alone never means settlement. No chain state or checkpoint is modified.
 *
 * @param env - Private real-run checkpoint and network configuration.
 * @throws {Error} If request records, settlement confirmation, or bounded indexer reads disagree.
 */
export async function reconcileRealRequests(env: NodeJS.ProcessEnv): Promise<void> {
  await withVaultIndexer(env, async (provider) => {
    const state = await readVaultLedger(
      provider,
      requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    );
    for (const [requestKey, settlementKey, requests, pending] of [
      [
        "DEPOSIT_REQUEST_ID",
        "REAL_DEPOSIT_SETTLED_TX_ID",
        state.depositEventMap,
        state.depositSettleViews,
      ],
      [
        "WITHDRAW_REQUEST_ID",
        "REAL_WITHDRAW_SETTLED_TX_ID",
        state.signBidirectionalEventMap,
        state.withdrawSettleViews,
      ],
    ] as const) {
      const savedId = env[requestKey];
      const key = savedId === undefined ? undefined : requestIdBytes(parseRequestIdHex(savedId));
      assertRealRequestCheckpoint(
        env,
        requestKey,
        settlementKey,
        key === undefined ? !requests.isEmpty() : requests.member(key),
        key === undefined ? !pending.isEmpty() : pending.member(key),
      );
      const txId = env[settlementKey];
      if (txId !== undefined) {
        const confirmed = await provider.watchForTxData(txId);
        if (
          confirmed.status !== SucceedEntirely ||
          confirmed.txId !== txId ||
          !confirmed.identifiers.includes(txId)
        )
          throw new Error(
            `reconcile ${settlementKey}: recorded settlement did not succeed entirely`,
          );
      }
    }
  });
}
