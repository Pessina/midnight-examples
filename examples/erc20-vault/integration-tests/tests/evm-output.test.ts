import {
  asciiPadded,
  bytesToHex,
  calculateRequestId,
  contractAddressFromHex,
  deriveEpsilon,
  deriveEvmAddress,
  deriveMidnightResponseKey,
  hexToBytes,
  MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
  MPCDestination,
  MPCSignatureAlgorithm,
  requestIdBytes,
  requestIdHex,
  type RespondBidirectionalEvent,
  SECP256K1_ORDER,
  type SignBidirectionalEvent,
  signBidirectionalEventToUnsignedEvmTransaction,
  SignetRequestResponseReader,
  TxParamType,
} from "@sig-net/midnight";
import {
  calculateSignetAttestationDigest,
  ecdsaSignatureToMpcSignature,
  signAttestationDigest,
  signatureToSignatureRespondedEvent,
} from "@sig-net/midnight/testing";
import { JsonRpcProvider, Network, SigningKey, Transaction } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEvmOutputProvider,
  createRealEvmOutputProvider,
  parseCallTracerOutput,
} from "../src/evm-output.ts";
import * as fakenetResponses from "../src/fakenet-responses.ts";
import { resolveAttestedRespondOutcome } from "../src/flows/respond-output.ts";
import { VAULT_MPC_ROUTING } from "../src/mpc-routing.ts";

const VAULT = "11".repeat(32);
const ROOT = new SigningKey(`0x${"00".repeat(31)}01`);
const REQUEST: SignBidirectionalEvent = {
  ...VAULT_MPC_ROUTING,
  sender: contractAddressFromHex(VAULT),
  requestNonce: 0n,
  keyVersion: 1n,
  path: new Uint8Array([0x42, ...new Uint8Array(31)]),
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  txParamType: TxParamType.evmType2,
  caip2Id: asciiPadded("eip155:11155111", 32),
  txParams: {
    chainId: 11155111n,
    nonce: 0n,
    maxPriorityFeePerGas: 1n,
    maxFeePerGas: 10n,
    gasLimit: 100_000n,
    to: new Uint8Array(20).fill(0x33),
    value: 0n,
    calldata: {
      is_some: true,
      value: { selector: new Uint8Array([1, 2, 3, 4]), noWords: 0n, words: [] },
    },
    accessListEntryCount: 0n,
    accessList: [],
  },
};
const REQUEST_ID = requestIdHex(calculateRequestId(REQUEST));
const TX = Transaction.from({
  type: 2,
  chainId: 11155111,
  to: `0x${"33".repeat(20)}`,
  data: "0x01020304",
});
TX.signature = ROOT.sign(TX.unsignedHash);
const OUTPUT = `0x${"00".repeat(31)}01`;
const TRACE = { type: "CALL", from: TX.from, to: TX.to, input: TX.data, output: OUTPUT };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("callTracer output boundary", () => {
  it("reads the matching root output", () => {
    expect(parseCallTracerOutput(TRACE, TX)).toBe(OUTPUT);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "0x01"],
    ["opcode tracer", { gas: 100, returnValue: OUTPUT, structLogs: [] }],
    ["missing output", { ...TRACE, output: undefined }],
    ["empty output", { ...TRACE, output: "0x" }],
    ["odd hex", { ...TRACE, output: "0x1" }],
    ["invalid hex", { ...TRACE, output: "0xgg" }],
    ["numeric output", { ...TRACE, output: 1 }],
    ["error", { ...TRACE, error: "execution reverted" }],
    ["wrong call", { ...TRACE, type: "DELEGATECALL" }],
    ["wrong sender", { ...TRACE, from: TX.to }],
    ["wrong target", { ...TRACE, to: TX.from }],
    ["wrong input", { ...TRACE, input: "0x" }],
    ["inner output only", { ...TRACE, output: undefined, calls: [TRACE] }],
  ])("rejects %s", (_name, trace) => {
    expect(() => parseCallTracerOutput(trace, TX)).toThrow();
  });
});

function arrange() {
  const reader = new SignetRequestResponseReader({
    requesterContractAddress: VAULT,
    requesterRequestsPath: [1, 3],
    signetContractAddress: "44".repeat(32),
    publicDataProvider: { queryContractState: () => Promise.resolve(null) },
    eventSource: { querySignetEvents: () => Promise.resolve([]) },
  });
  vi.spyOn(reader, "getSignatureRequest").mockResolvedValue(REQUEST);
  const unsigned = signBidirectionalEventToUnsignedEvmTransaction(REQUEST);
  const childKey = new SigningKey(
    `0x${((1n + deriveEpsilon(VAULT, bytesToHex(REQUEST.path))) % SECP256K1_ORDER).toString(16).padStart(64, "0")}`,
  );
  const signature = signatureToSignatureRespondedEvent(childKey.sign(unsigned.unsignedHash));
  const forged = signatureToSignatureRespondedEvent(ROOT.sign(unsigned.unsignedHash));
  vi.spyOn(reader, "getSignatureRespondedEvents").mockResolvedValue([forged, signature]);
  const signed = Transaction.from(unsigned);
  signed.signature = childKey.sign(unsigned.unsignedHash);
  vi.spyOn(JsonRpcProvider.prototype, "getNetwork").mockResolvedValue(Network.from(11155111));
  const blockHash = `0x${"55".repeat(32)}`;
  const receipt = vi.spyOn(JsonRpcProvider.prototype, "getTransactionReceipt").mockResolvedValue({
    hash: signed.hash,
    status: 1,
    blockNumber: 12,
    blockHash,
  } as Awaited<ReturnType<JsonRpcProvider["getTransactionReceipt"]>>);
  vi.spyOn(JsonRpcProvider.prototype, "getBlock").mockResolvedValue({ hash: blockHash } as Awaited<
    ReturnType<JsonRpcProvider["getBlock"]>
  >);
  const send = vi.spyOn(JsonRpcProvider.prototype, "send").mockResolvedValue({
    type: "CALL",
    from: signed.from,
    to: signed.to,
    input: signed.data,
    output: OUTPUT,
  });
  const destroy = vi.spyOn(JsonRpcProvider.prototype, "destroy");
  return { reader, signed, receipt, send, destroy };
}

describe("default output selection", () => {
  it.each([
    { success: true, output: OUTPUT, expected: OUTPUT },
    { success: false, output: OUTPUT, expected: undefined },
    { success: true, output: null, expected: undefined },
  ])(
    "reads the explicit fake environment ($success, $output)",
    async ({ success, output, expected }) => {
      vi.stubEnv("MPC_MODE", "real");
      const { reader, send } = arrange();
      const fetchResponse = vi.spyOn(fakenetResponses, "fetchFakenetResponse").mockResolvedValue({
        requestId: REQUEST_ID,
        success,
        output,
        txHash: `0x${"55".repeat(32)}`,
        observedAt: "2026-01-01T00:00:00.000Z",
      });
      const env = {};
      expect(await createEvmOutputProvider(env)(reader, REQUEST_ID)).toBe(expected);
      expect(fetchResponse).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, 3000, env);
      expect(send).not.toHaveBeenCalled();
    },
  );
});

describe("real execution output", () => {
  it.each([
    { name: "exact execution output", traceOutput: OUTPUT, accepted: true },
    { name: "altered execution output", traceOutput: `0x${"00".repeat(32)}`, accepted: false },
  ])(
    "authenticates RespondBidirectional over $name through the real output provider",
    async ({ traceOutput, accepted }) => {
      const { reader, signed, send } = arrange();
      const responseSecret: Uint8Array = hexToBytes(
        ((1n + deriveEpsilon(VAULT, MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH)) % SECP256K1_ORDER)
          .toString(16)
          .padStart(64, "0"),
      );
      const event: RespondBidirectionalEvent = {
        signature: ecdsaSignatureToMpcSignature(
          signAttestationDigest(
            calculateSignetAttestationDigest(requestIdBytes(REQUEST_ID), new Uint8Array([1])),
            responseSecret,
          ),
        ),
      };
      vi.spyOn(reader, "getRespondBidirectionalEvents").mockResolvedValue([event]);
      send.mockResolvedValue({
        type: "CALL",
        from: signed.from,
        to: signed.to,
        input: signed.data,
        output: traceOutput,
      });
      const key = deriveMidnightResponseKey(ROOT.compressedPublicKey, VAULT);
      const result = await resolveAttestedRespondOutcome(
        reader,
        REQUEST_ID,
        key,
        createRealEvmOutputProvider(
          "https://sepolia.gateway.tenderly.co/offline-test",
          ROOT.compressedPublicKey,
          VAULT,
        ),
        key,
      );
      expect(result).toEqual(
        accepted
          ? {
              event,
              serializedOutput: new Uint8Array([1]),
              succeeded: true,
              matchedFailureOutput: false,
            }
          : undefined,
      );
      expect(send).toHaveBeenCalledExactlyOnceWith("debug_traceTransaction", [
        signed.hash,
        { tracer: "callTracer", tracerConfig: { onlyTopCall: true } },
      ]);
    },
  );

  it("bounds an unresponsive reader and releases its provider", async () => {
    vi.useFakeTimers();
    const { reader, send, destroy } = arrange();
    vi.spyOn(reader, "getSignatureRequest").mockReturnValue(
      new Promise<SignBidirectionalEvent>(() => {
        // The reader remains pending beyond the output provider deadline.
      }),
    );
    const output = createRealEvmOutputProvider(
      "https://ethereum-sepolia-rpc.publicnode.com",
      ROOT.compressedPublicKey,
      VAULT,
    );
    const pending = output(reader, REQUEST_ID);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("traces the SDK-verified transaction and destroys its provider", async () => {
    const { reader, signed, send, destroy } = arrange();
    const output = createRealEvmOutputProvider(
      "https://ethereum-sepolia-rpc.publicnode.com",
      ROOT.compressedPublicKey,
      VAULT,
    );
    expect(await output(reader, REQUEST_ID)).toBe(OUTPUT);
    expect(signed.from).toBe(
      deriveEvmAddress(ROOT.compressedPublicKey, VAULT, bytesToHex(REQUEST.path)),
    );
    expect(send).toHaveBeenCalledExactlyOnceWith("debug_traceTransaction", [
      signed.hash,
      { tracer: "callTracer", tracerConfig: { onlyTopCall: true } },
    ]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([
    "unmined",
    "wrong receipt",
    "reverted",
    "wrong block",
    "wrong chain",
    "trace unavailable",
    "forged only",
    "malformed trace",
  ])("has no success candidate for %s", async (failure) => {
    const { reader, receipt, send, destroy } = arrange();
    if (failure === "unmined") receipt.mockResolvedValue(null);
    if (failure === "wrong receipt")
      receipt.mockResolvedValue({
        hash: `0x${"99".repeat(32)}`,
        status: 1,
        blockNumber: 12,
        blockHash: `0x${"55".repeat(32)}`,
      } as Awaited<ReturnType<JsonRpcProvider["getTransactionReceipt"]>>);
    if (failure === "reverted")
      receipt.mockResolvedValue({ status: 0 } as Awaited<
        ReturnType<JsonRpcProvider["getTransactionReceipt"]>
      >);
    if (failure === "wrong block")
      vi.spyOn(JsonRpcProvider.prototype, "getBlock").mockResolvedValue({
        hash: `0x${"99".repeat(32)}`,
      } as Awaited<ReturnType<JsonRpcProvider["getBlock"]>>);
    if (failure === "wrong chain")
      vi.spyOn(JsonRpcProvider.prototype, "getNetwork").mockResolvedValue(Network.from(1));
    if (failure === "trace unavailable") send.mockRejectedValue(new Error("method not supported"));
    if (failure === "malformed trace")
      send.mockResolvedValue({ returnValue: OUTPUT, structLogs: [] });
    if (failure === "forged only")
      vi.spyOn(reader, "getSignatureRespondedEvents").mockResolvedValue([
        signatureToSignatureRespondedEvent(
          ROOT.sign(signBidirectionalEventToUnsignedEvmTransaction(REQUEST).unsignedHash),
        ),
      ]);
    const output = createRealEvmOutputProvider(
      "https://ethereum-sepolia-rpc.publicnode.com",
      ROOT.compressedPublicKey,
      VAULT,
    );
    expect(await output(reader, REQUEST_ID)).toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(
      failure === "trace unavailable" || failure === "malformed trace" ? 1 : 0,
    );
  });
});
