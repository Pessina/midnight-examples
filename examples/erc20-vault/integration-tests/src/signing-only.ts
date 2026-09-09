import {
  bytesToHex,
  calculateRequestId,
  deriveEvmAddress,
  parseRequestIdHex,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  signBidirectionalEventToUnsignedEvmTransaction,
} from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_DEPOSIT_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { resolveInitialiseConfig } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { MpcMode, requireEnv } from "@sig-net/midnight-examples-test-harness";
import { JsonRpcProvider, type Transaction } from "ethers";

import { initialise } from "./flows/initialise.ts";
import { pollSignatureResponse } from "./flows/poll-signature-response.ts";
import { startDeposit } from "./flows/start-deposit.ts";
import { readSigningProvenance, type SigningProvenance } from "./signing-provenance.ts";
import { createResponseReader, type VaultContext } from "./vault-context.ts";

/**
 * Authenticate exact transaction bytes against the on-ledger request and derived MPC signer.
 *
 * @param request - Exact request read from the vault ledger.
 * @param requestId - Expected request digest.
 * @param transaction - Signed transaction returned by the response reader.
 * @param rootPublicKey - Configured public MPC root key.
 * @returns The verified derived EVM signer.
 * @throws {Error} If the request ID, transaction bytes, or signature signer disagree.
 */
export function verifySignedRequest(
  request: SignBidirectionalEvent,
  requestId: RequestIdHex,
  transaction: Transaction,
  rootPublicKey: string,
): string {
  if (requestIdHex(calculateRequestId(request)) !== requestId)
    throw new Error("stored request digest differs from reserved request ID");
  const unsigned = signBidirectionalEventToUnsignedEvmTransaction(request);
  if (transaction.unsignedSerialized !== unsigned.unsignedSerialized)
    throw new Error("signed transaction differs from the exact stored request");
  const expectedSigner = deriveEvmAddress(
    rootPublicKey,
    bytesToHex(request.sender.bytes),
    bytesToHex(request.path),
  );
  if (transaction.from?.toLowerCase() !== expectedSigner.toLowerCase())
    throw new Error("Respond signature does not recover to the root-derived requester signer");
  return expectedSigner;
}

/** Public evidence of a completed signing-only request. */
export interface SigningOnlyResult {
  /** Exact request identifier. */
  readonly requestId: RequestIdHex;
  /** MPC-derived verified signer. */
  readonly expectedSigner: string;
  /** Exact signed transaction; persisted privately before return. */
  readonly transaction: Transaction;
  /** Canonical finalized source of the Respond and request notification. */
  readonly provenance: SigningProvenance;
}

/**
 * Initialise, submit or resume one deposit request, and authenticate its finalized MPC Respond.
 * No EVM funding assertion or broadcast is part of this stage.
 *
 * @param context - Connected real vault and providers.
 * @param env - Private journal-backed environment.
 * @param amount - Requested USDC base units.
 * @returns The authenticated transaction and public chain evidence.
 * @throws {Error} If chain/configuration, request, signature, persistence or finality checks fail.
 */
export async function runSigningOnly(
  context: VaultContext,
  env: NodeJS.ProcessEnv,
  amount: bigint,
): Promise<SigningOnlyResult> {
  if (context.mpcMode !== MpcMode.Real)
    throw new Error("signing-only requires the deployed real MPC");
  const checkpoint = context.checkpoint;
  if (!checkpoint) throw new Error("signing-only requires a durable private checkpoint");
  const config = resolveInitialiseConfig(env, context.vaultContractAddress);
  await initialise(context, config);
  const ledger = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (
    ledger.initialised !== 1n ||
    ledger.evmChainId !== 11155111n ||
    `0x${bytesToHex(ledger.vaultEvmAddress)}`.toLowerCase() !==
      context.evmVaultAddress.toLowerCase()
  )
    throw new Error("initialised vault chain/address differs from signing configuration");
  const provider = new JsonRpcProvider(context.evmRpcUrl);
  let requestId: RequestIdHex;
  try {
    if ((await provider.getNetwork()).chainId !== 11155111n)
      throw new Error("signing-only RPC must be Sepolia");
    if ((await provider.getCode(context.erc20Address)) === "0x")
      throw new Error("configured Sepolia ERC20 has no deployed code");
    requestId = env.DEPOSIT_REQUEST_ID
      ? parseRequestIdHex(env.DEPOSIT_REQUEST_ID)
      : await startDeposit(context, {
          amount,
          evmNonce: BigInt(await provider.getTransactionCount(context.evmUserAddress, "pending")),
        });
  } finally {
    provider.destroy();
  }
  const reader = createResponseReader(context, VAULT_DEPOSIT_REQUESTS_PATH);
  const request = await reader.getSignatureRequest(requestId);
  const unsigned = signBidirectionalEventToUnsignedEvmTransaction(request);
  const rootPublicKey = requireEnv(env, "MPC_SECP256K1_PUBKEY");
  const expectedSigner = deriveEvmAddress(
    rootPublicKey,
    bytesToHex(request.sender.bytes),
    bytesToHex(request.path),
  );
  if (
    expectedSigner.toLowerCase() !== context.evmUserAddress.toLowerCase() ||
    bytesToHex(request.sender.bytes) !== context.vaultContractAddress.toLowerCase() ||
    bytesToHex(request.path) !== context.identity.commitmentHex
  )
    throw new Error("request belongs to a different requester identity");
  checkpoint({
    REAL_DEPOSIT_UNSIGNED_TRANSACTION: unsigned.unsignedSerialized,
    REAL_DEPOSIT_KEY_VERSION: String(request.keyVersion),
    REAL_DEPOSIT_PATH: bytesToHex(request.path),
    REAL_DEPOSIT_REQUESTER: bytesToHex(request.sender.bytes),
    REAL_DEPOSIT_EXPECTED_SIGNER: expectedSigner,
  });
  const transaction = await pollSignatureResponse(context, {
    requestId,
    intervalMs: 3000,
    timeoutMs: 15 * 60_000,
    expectedSigner,
    requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
  });
  verifySignedRequest(request, requestId, transaction, rootPublicKey);
  checkpoint({ REAL_DEPOSIT_SIGNED_TRANSACTION: transaction.serialized });
  const provenance = await readSigningProvenance(context, requestId, request, transaction);
  checkpoint({ REAL_DEPOSIT_RESPOND_PROVENANCE: JSON.stringify(provenance) });
  console.log(
    `verified finalized MPC Respond request=${requestId} signer=${expectedSigner} unsignedHash=${transaction.unsignedHash} signedHash=${String(transaction.hash)} RespondTx=${provenance.respond.transactionHash} block=${String(provenance.respond.blockHeight)}`,
  );
  return { requestId, expectedSigner, transaction, provenance };
}
