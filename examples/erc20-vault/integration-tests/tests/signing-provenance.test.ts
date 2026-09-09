import {
  asciiPadded,
  calculateRequestId,
  parseRequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  TxParamType,
} from "@sig-net/midnight";
import { Transaction } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VAULT_MPC_ROUTING } from "../src/mpc-routing.ts";
import { assertFinalizedEvent, readSigningProvenance } from "../src/signing-provenance.ts";
import type { VaultContext } from "../src/vault-context.ts";
const EVENT = {
  eventId: 1,
  transactionHash: "aa".repeat(32),
  blockHash: "bb".repeat(32),
  blockHeight: 10,
};
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("canonical finalized signing evidence", () => {
  it("accepts a canonical finalized block", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ result: `0x${"dd".repeat(32)}` }))
      .mockResolvedValueOnce(Response.json({ result: { number: "0xa" } }))
      .mockResolvedValueOnce(Response.json({ result: `0x${EVENT.blockHash}` }));
    vi.stubGlobal("fetch", fetcher);
    await expect(assertFinalizedEvent("https://node.invalid", EVENT, 0)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    { name: "unfinalized block", height: "0x9", canonical: `0x${EVENT.blockHash}` },
    { name: "different canonical block", height: "0xa", canonical: `0x${"cc".repeat(32)}` },
  ])("rejects $name", async ({ height, canonical }) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ result: `0x${"dd".repeat(32)}` }))
      .mockResolvedValueOnce(Response.json({ result: { number: height } }))
      .mockResolvedValueOnce(Response.json({ result: canonical }));
    vi.stubGlobal("fetch", fetcher);
    await expect(assertFinalizedEvent("https://node.invalid", EVENT, 0)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalled();
  });
});

// Captured from the published rc.6 singleton's signBidirectional/respond circuits,
// decoded through the SDK's decodeSignetLogEvents with synthetic test accounts.
const EMITTED = {
  requestId: "dc649501b63b25233d1239def926a4d1a0d11bca9e9623793b13e1198d080c00",
  unsignedTransaction:
    "0x02ec83aa36a780843b9aca008506fc23ac00830186a09444444444444444444444444444444444444444448080c0",
  signedTransaction:
    "0x02f86f83aa36a780843b9aca008506fc23ac00830186a09444444444444444444444444444444444444444448080c080a04962eed809338c20a32f1cc29f8f8c6cb721983518689a582e71892d337a65a0a0097eeae0e06f771a25506014cfabb2fe1baf64a1216223d492956918d44b2aa2",
  goodNotification: {
    id: 1,
    name: "5369676e4269646972656374696f6e616c4576656e7400000000000000000000",
    payload:
      "01dc649501b63b25233d1239def926a4d1a0d11bca9e9623793b13e1198d080c0022222222222222222222222222222222222222222222222222222222222222220201030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    transaction: {
      hash: "0000000000000000000000000000000000000000000000000000000000000001",
      block: {
        height: 10,
        hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
  },
  badNotification: {
    id: 2,
    name: "5369676e4269646972656374696f6e616c4576656e7400000000000000000000",
    payload:
      "02dc649501b63b25233d1239def926a4d1a0d11bca9e9623793b13e1198d080c0022222222222222222222222222222222222222222222222222222222222222220201030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    transaction: {
      hash: "0000000000000000000000000000000000000000000000000000000000000002",
      block: {
        height: 10,
        hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
  },
  wrongResponse: {
    id: 3,
    name: "5369676e6174757265526573706f6e6465644576656e74000000000000000000",
    payload:
      "dc649501b63b25233d1239def926a4d1a0d11bca9e9623793b13e1198d080c00b088b1cd354cd156fac2c015d4f87752a667712cd6989e88a737b1e3218aa03ac2a16c3dc5feca68cb3e4baaf1ea00efcdb411a479e0b1a8bd715609aa09b12150cefab58d426a948f503324044802febf0fd8cfb0b23a23815bd608dab34a110100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    transaction: {
      hash: "0000000000000000000000000000000000000000000000000000000000000003",
      block: {
        height: 10,
        hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
  },
  goodResponse: {
    id: 4,
    name: "5369676e6174757265526573706f6e6465644576656e74000000000000000000",
    payload:
      "dc649501b63b25233d1239def926a4d1a0d11bca9e9623793b13e1198d080c004962eed809338c20a32f1cc29f8f8c6cb721983518689a582e71892d337a65a02de1e491b20ea4efb3cd4ab1b132e67288ec6917877b2b74fbf02a2302be0366097eeae0e06f771a25506014cfabb2fe1baf64a1216223d492956918d44b2aa20000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    transaction: {
      hash: "0000000000000000000000000000000000000000000000000000000000000004",
      block: {
        height: 10,
        hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
  },
} as const;

const REQUEST: SignBidirectionalEvent = {
  sender: { bytes: new Uint8Array(32).fill(0x22) },
  requestNonce: 0n,
  keyVersion: 1n,
  path: new Uint8Array(32).fill(0x33),
  ...VAULT_MPC_ROUTING,
  txParamType: TxParamType.evmType2,
  caip2Id: asciiPadded("eip155:11155111", 32),
  txParams: {
    to: new Uint8Array(20).fill(0x44),
    chainId: 11155111n,
    nonce: 0n,
    gasLimit: 100000n,
    maxFeePerGas: 30000000000n,
    maxPriorityFeePerGas: 1000000000n,
    value: 0n,
    accessListEntryCount: 0n,
    accessList: [],
    calldata: { is_some: false, value: { selector: new Uint8Array(4), noWords: 0n, words: [] } },
  },
};

it("finds genuine emitted evidence after unauthenticated malformed notifications and wrong signatures", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: {
          contractEvents: [
            EMITTED.badNotification,
            EMITTED.goodNotification,
            EMITTED.wrongResponse,
            EMITTED.goodResponse,
          ],
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ result: `0x${"dd".repeat(32)}` }))
    .mockResolvedValueOnce(Response.json({ result: { number: "0xa" } }))
    .mockResolvedValueOnce(Response.json({ result: `0x${"bb".repeat(32)}` }))
    .mockResolvedValueOnce(Response.json({ result: `0x${"dd".repeat(32)}` }))
    .mockResolvedValueOnce(Response.json({ result: { number: "0xa" } }))
    .mockResolvedValueOnce(Response.json({ result: `0x${"bb".repeat(32)}` }));
  vi.stubGlobal("fetch", fetcher);
  const context = {
    signetContractAddress: "11".repeat(32),
    nodeConfig: { indexerUrl: "https://indexer.invalid", nodeUrl: "https://node.invalid" },
  } as unknown as VaultContext;
  expect(requestIdHex(calculateRequestId(REQUEST))).toBe(EMITTED.requestId);
  const result = await readSigningProvenance(
    context,
    parseRequestIdHex(EMITTED.requestId),
    REQUEST,
    Transaction.from(EMITTED.signedTransaction),
  );
  expect(result).toEqual({
    request: {
      eventId: 1,
      transactionHash: EMITTED.goodNotification.transaction.hash,
      blockHash: EMITTED.goodNotification.transaction.block.hash,
      blockHeight: 10,
    },
    respond: {
      eventId: 4,
      transactionHash: EMITTED.goodResponse.transaction.hash,
      blockHash: EMITTED.goodResponse.transaction.block.hash,
      blockHeight: 10,
    },
  });
  expect(fetcher).toHaveBeenCalledTimes(7);
});
