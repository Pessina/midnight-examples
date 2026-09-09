import {
  deriveMidnightResponseKey,
  deserializeEvmOutput,
  formatSecp256k1PublicKey,
  MPC_FAILURE_OUTPUT,
  requestIdBytes,
  type RequestIdHex,
  type RespondBidirectionalEvent,
  type Secp256k1Point,
  serializeRespondOutput,
  type SignetRequestResponseReader,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";
import { MpcMode } from "@sig-net/midnight-examples-test-harness";

import type { EvmOutputProvider } from "../evm-output.ts";
import { createResponseReader, type VaultContext } from "../vault-context.ts";
import { warnOnce } from "../warn-once.ts";

/** What the MPC attested for a request, resolved by signature verification. */
export interface RespondOutcome {
  /** The attested event whose signature verified over a recomputed candidate. */
  readonly event: RespondBidirectionalEvent;
  /** The recomputed output bytes the signature covers (a circuit argument). */
  readonly serializedOutput: Uint8Array;
  /** True only for an executed transfer whose attested return value is true. */
  readonly succeeded: boolean;
  /** True only for the SDK's fixed failure bytes, selecting the refund circuit. */
  readonly matchedFailureOutput: boolean;
}

/**
 * Authenticate an execution outcome using the vault's pinned key and independent output source.
 * The fixed failure candidate is checked before obtaining execution output: a replaced transaction
 * need not have a receipt, and an unavailable trace must not hide an authenticated failure.
 *
 * @param reader - SDK reader over the vault request map and external signet event source.
 * @param requestId - Request whose signatures and output are being checked.
 * @param mpcResponseKey - Response key read from the vault ledger, also checked by settlement circuits.
 * @param outputProvider - Untrusted output lookup, used only after no failure attestation verifies.
 * @param expectedResponseKey - Publicly derived response key required in real mode.
 * @returns A verified outcome, or undefined when no candidate verifies this poll tick.
 * @throws {Error} If the pinned key disagrees with the configured public derivation or event reads fail.
 */
export async function resolveAttestedRespondOutcome(
  reader: SignetRequestResponseReader,
  requestId: RequestIdHex,
  mpcResponseKey: Secp256k1Point,
  outputProvider: EvmOutputProvider,
  expectedResponseKey?: Secp256k1Point,
): Promise<RespondOutcome | undefined> {
  if (
    expectedResponseKey !== undefined &&
    formatSecp256k1PublicKey(mpcResponseKey) !== formatSecp256k1PublicKey(expectedResponseKey)
  ) {
    throw new Error("vault response key does not match the configured MPC public key derivation");
  }
  const events = await reader.getRespondBidirectionalEvents(requestId);
  if (events.length === 0) return undefined;
  const failureEvent = events.find((event) =>
    verifyRespondBidirectionalSignature(
      requestIdBytes(requestId),
      MPC_FAILURE_OUTPUT,
      event,
      mpcResponseKey,
    ),
  );
  if (failureEvent !== undefined) {
    return {
      event: failureEvent,
      serializedOutput: MPC_FAILURE_OUTPUT,
      succeeded: false,
      matchedFailureOutput: true,
    };
  }
  try {
    const output = await outputProvider(reader, requestId);
    if (output === undefined) return undefined;
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(output))
      throw new Error("execution output has no valid bytes");
    const request = await reader.getSignatureRequest(requestId);
    const decoded = deserializeEvmOutput(request.outputDeserializationSchema, output);
    if (typeof decoded.success !== "boolean")
      throw new Error("execution output does not contain the transfer result boolean");
    const serializedOutput = serializeRespondOutput(request.respondSerializationSchema, decoded);
    const event = events.find((posted) =>
      verifyRespondBidirectionalSignature(
        requestIdBytes(requestId),
        serializedOutput,
        posted,
        mpcResponseKey,
      ),
    );
    return event === undefined
      ? undefined
      : { event, serializedOutput, succeeded: decoded.success, matchedFailureOutput: false };
  } catch (error) {
    warnOnce(
      `output:${requestId}`,
      `execution output unavailable for ${requestId}: ${String(error)}`,
    );
    return undefined;
  }
}

/**
 * Resolve the vault's attested transfer outcome through its explicitly selected output provider.
 * Settlement circuits repeat the SDK signature verification over the returned bytes.
 *
 * @param context - Validated flow configuration and providers.
 * @param requestId - Request whose attestation is being resolved.
 * @param requestsPath - Request-map path; defaults to the shared withdrawal map.
 * @returns A verified outcome, or undefined when no available candidate verifies.
 * @throws {Error} If required key configuration, ledger reads or response event reads fail.
 */
export async function fetchAttestedRespondOutcome(
  context: VaultContext,
  requestId: RequestIdHex,
  requestsPath?: readonly number[],
): Promise<RespondOutcome | undefined> {
  const reader = createResponseReader(context, requestsPath);
  const { mpcResponseKey } = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  let expectedResponseKey: Secp256k1Point | undefined;
  if (context.mpcMode === MpcMode.Real) {
    if (context.mpcPublicKey === undefined) throw new Error("real MPC public key is required");
    expectedResponseKey = deriveMidnightResponseKey(
      context.mpcPublicKey,
      context.vaultContractAddress,
    );
  }
  return resolveAttestedRespondOutcome(
    reader,
    requestId,
    mpcResponseKey,
    context.evmOutputProvider,
    expectedResponseKey,
  );
}
