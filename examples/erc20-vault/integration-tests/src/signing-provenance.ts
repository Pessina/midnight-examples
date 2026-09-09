import { setTimeout as delay } from "node:timers/promises";

import {
  bytesToHex,
  decodeSignatureRespondedEventPayload,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  isSignetEventNamed,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  signBidirectionalEventToSignedEvmTransaction,
  SignetEventName,
  signetEventSourceFromPublicDataProvider,
} from "@sig-net/midnight";
import { VAULT_DEPOSIT_REQUESTS_PATH } from "@sig-net/midnight-examples-erc20-vault-contract";
import type { Transaction } from "ethers";

import type { VaultContext } from "./vault-context.ts";

/** Public identity of a singleton event and its canonical finalized transaction. */
export interface FinalizedEventEvidence {
  /** Canonical indexer event ID. */
  readonly eventId: number;
  /** Chain transaction hash, distinct from indexer database IDs. */
  readonly transactionHash: string;
  /** Canonical block hash. */
  readonly blockHash: string;
  /** Canonical block height. */
  readonly blockHeight: number;
}

/** Canonical finalized notification and cryptographically matched Respond evidence. */
export interface SigningProvenance {
  /** Request notification emitted by the singleton. */
  readonly request: FinalizedEventEvidence;
  /** Authenticated transaction signature emitted by the singleton. */
  readonly respond: FinalizedEventEvidence;
}

interface IndexedMiscEvent {
  readonly id: number;
  readonly name: string;
  readonly payload: string;
  readonly transaction: {
    readonly hash: string;
    readonly block: { readonly hash: string; readonly height: number };
  };
}

interface EventPage {
  readonly data?: { readonly contractEvents: readonly IndexedMiscEvent[] };
  readonly errors?: readonly { readonly message: string }[];
}

interface RpcResult<T> {
  readonly result?: T;
  readonly error?: { readonly code: number; readonly message: string };
}

async function nodeRead<T>(
  url: string,
  method: string,
  params: readonly (string | number)[],
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Midnight finality RPC HTTP ${String(response.status)}`);
  const body = (await response.json()) as RpcResult<T>;
  if (body.error || body.result === undefined)
    throw new Error(`Midnight finality RPC ${method} returned no result`);
  return body.result;
}

/**
 * Verify a source event is in the canonical chain at or below the finalized head.
 *
 * @param nodeUrl - Midnight node JSON-RPC endpoint.
 * @param event - Event identity from the indexer's transaction relation.
 * @param timeoutMs - Maximum time to wait for the event height to finalize.
 * @throws {Error} If height or canonical finalized block identity cannot be established.
 */
export async function assertFinalizedEvent(
  nodeUrl: string,
  event: FinalizedEventEvidence,
  timeoutMs = 120_000,
): Promise<void> {
  if (!Number.isSafeInteger(event.blockHeight) || event.blockHeight < 0)
    throw new Error("invalid event block height");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const finalizedHash = await nodeRead<string>(nodeUrl, "chain_getFinalizedHead", []);
    const header = await nodeRead<{ readonly number: string }>(nodeUrl, "chain_getHeader", [
      finalizedHash,
    ]);
    if (BigInt(header.number) >= BigInt(event.blockHeight)) {
      const canonicalHash = await nodeRead<string>(nodeUrl, "chain_getBlockHash", [
        event.blockHeight,
      ]);
      if (
        canonicalHash.replace(/^0x/u, "").toLowerCase() !==
        event.blockHash.replace(/^0x/u, "").toLowerCase()
      )
        throw new Error("Respond/request block differs from canonical finalized chain");
      console.log(
        `canonical finalized event=${String(event.eventId)} tx=${event.transactionHash} block=${String(event.blockHeight)} blockHash=${canonicalHash} finalizedHead=${finalizedHash} finalizedHeight=${String(BigInt(header.number))}`,
      );
      return;
    }
    if (Date.now() >= deadline)
      throw new Error("Respond/request block did not finalize before the deadline");
    await delay(Math.min(3000, deadline - Date.now()));
  }
}

function evidence(event: IndexedMiscEvent): FinalizedEventEvidence {
  return {
    eventId: event.id,
    transactionHash: event.transaction.hash,
    blockHash: event.transaction.block.hash,
    blockHeight: event.transaction.block.height,
  };
}

/**
 * Resolve original singleton event provenance and confirm canonical Midnight finality.
 * The indexer's owning MiscContractEvent.transaction relation supplies chain hashes.
 *
 * @param context - Real vault and node configuration.
 * @param requestId - Exact reserved request digest.
 *
 * @param request - Exact stored request used for transaction reconstruction.
 * @param transaction - Authenticated signed transaction to match to a raw Respond.
 * @returns Canonical finalized event evidence for both sides of signing.
 * @throws {Error} If matching events or canonical finalized blocks cannot be established.
 */
export async function readSigningProvenance(
  context: VaultContext,
  requestId: RequestIdHex,
  request: SignBidirectionalEvent,
  transaction: Transaction,
): Promise<SigningProvenance> {
  let notification: FinalizedEventEvidence | undefined;
  let respond: FinalizedEventEvidence | undefined;
  for (let offset = 0; ; offset += 100) {
    const response = await fetch(context.nodeConfig.indexerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          "query SigningProvenance($filter: ContractEventFilter!, $offset: Int!) { contractEvents(filter: $filter, offset: $offset, limit: 100) { id ... on MiscContractEvent { name payload transaction { hash block { hash height } } } } }",
        variables: {
          filter: { contractAddress: context.signetContractAddress, types: ["MISC"] },
          offset,
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`signing provenance indexer HTTP ${String(response.status)}`);
    const body = (await response.json()) as EventPage;
    if (body.errors?.length || !body.data)
      throw new Error("signing provenance indexer query failed");
    for (const event of body.data.contractEvents) {
      const decodedEvents = await signetEventSourceFromPublicDataProvider({
        queryContractEvents: () =>
          Promise.resolve([{ eventType: "Misc", name: event.name, payload: event.payload }]),
      }).querySignetEvents(context.signetContractAddress);
      const decodedEvent = decodedEvents.at(0);
      if (!decodedEvent) throw new Error("indexer Misc event could not be decoded");
      const { name, payload } = decodedEvent;
      if (isSignetEventNamed({ name }, SignetEventName.SignatureRespondedEvent)) {
        const post = decodeSignatureRespondedEventPayload(payload);
        if (requestIdHex(post.requestId) === requestId) {
          try {
            if (
              signBidirectionalEventToSignedEvmTransaction(request, post.event).serialized ===
              transaction.serialized
            )
              respond ??= evidence(event);
          } catch {
            /* Unauthenticated malformed signatures are not matching evidence. */
          }
        }
      }
      if (isSignetEventNamed({ name }, SignetEventName.SignBidirectionalEvent)) {
        const post = decodeSignBidirectionalEventNotificationPayload(payload);
        if (requestIdHex(post.requestId) === requestId) {
          try {
            const decoded = decodeSignBidirectionalNotification(post.event);
            if (
              decoded.callerAddress === bytesToHex(request.sender.bytes) &&
              JSON.stringify(decoded.requestsPath) === JSON.stringify(VAULT_DEPOSIT_REQUESTS_PATH)
            )
              notification ??= evidence(event);
          } catch {
            /* A malformed unauthenticated notification cannot hide a later valid one. */
          }
        }
      }
    }
    if (notification && respond) break;
    if (body.data.contractEvents.length < 100)
      throw new Error("matching request and Respond provenance not indexed");
  }
  await assertFinalizedEvent(context.nodeConfig.nodeUrl, notification);
  await assertFinalizedEvent(context.nodeConfig.nodeUrl, respond);
  return { request: notification, respond };
}
