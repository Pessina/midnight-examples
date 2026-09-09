import {
  deriveEpsilon,
  deriveMidnightResponseKey,
  hexToBytes,
  MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
  MPC_FAILURE_OUTPUT,
  parseRequestIdHex,
  requestIdBytes,
  type RespondBidirectionalEvent,
  SECP256K1_ORDER,
  type Secp256k1Point,
  serializeRespondOutput,
  type SignBidirectionalEvent,
  SignetRequestResponseReader,
} from "@sig-net/midnight";
import {
  calculateSignetAttestationDigest,
  ecdsaSignatureToMpcSignature,
  secp256k1PublicKeyOf,
  signAttestationDigest,
} from "@sig-net/midnight/testing";
import { SigningKey } from "ethers";
import { describe, expect, it, vi } from "vitest";

import { resolveAttestedRespondOutcome } from "../src/flows/respond-output.ts";
import { ERC20_TRANSFER_RESULT_SCHEMA, VAULT_MPC_ROUTING } from "../src/mpc-routing.ts";

const VAULT = "11".repeat(32);
const REQUEST_ID = parseRequestIdHex("22".repeat(32));
const OTHER_REQUEST_ID = parseRequestIdHex("33".repeat(32));
const ROOT = new SigningKey(`0x${"00".repeat(31)}01`);
const RESPONSE_SECRET = hexToBytes(
  ((1n + deriveEpsilon(VAULT, MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH)) % SECP256K1_ORDER)
    .toString(16)
    .padStart(64, "0"),
);
const RESPONSE_KEY = deriveMidnightResponseKey(ROOT.compressedPublicKey, VAULT);
const OTHER_SECRET = new Uint8Array(32).fill(0x42);
const TRUE_OUTPUT = serializeRespondOutput(ERC20_TRANSFER_RESULT_SCHEMA, { success: true });
const FALSE_OUTPUT = serializeRespondOutput(ERC20_TRANSFER_RESULT_SCHEMA, { success: false });
const TRUE_ABI = `0x${"00".repeat(31)}01`;
const FALSE_ABI = `0x${"00".repeat(32)}`;

function respond(
  output: Uint8Array,
  requestId = REQUEST_ID,
  secret = RESPONSE_SECRET,
): RespondBidirectionalEvent {
  return {
    signature: ecdsaSignatureToMpcSignature(
      signAttestationDigest(
        calculateSignetAttestationDigest(requestIdBytes(requestId), output),
        secret,
      ),
    ),
  };
}

function arrange(events: RespondBidirectionalEvent[]) {
  const reader = new SignetRequestResponseReader({
    requesterContractAddress: VAULT,
    requesterRequestsPath: [1, 3],
    signetContractAddress: "44".repeat(32),
    publicDataProvider: { queryContractState: () => Promise.resolve(null) },
    eventSource: { querySignetEvents: () => Promise.resolve([]) },
  });
  vi.spyOn(reader, "getRespondBidirectionalEvents").mockResolvedValue(events);
  vi.spyOn(reader, "getSignatureRequest").mockResolvedValue(
    VAULT_MPC_ROUTING as SignBidirectionalEvent,
  );
  return reader;
}

describe("attested execution output", () => {
  it.each([
    { name: "executed true", serializedOutput: TRUE_OUTPUT, abi: TRUE_ABI, succeeded: true },
    { name: "executed false", serializedOutput: FALSE_OUTPUT, abi: FALSE_ABI, succeeded: false },
  ])(
    "preserves $name and rejects forged earlier posts",
    async ({ serializedOutput, abi, succeeded }) => {
      const event = respond(serializedOutput);
      const reader = arrange([respond(serializedOutput, REQUEST_ID, OTHER_SECRET), event]);
      const source = vi.fn().mockResolvedValue(abi);
      expect(
        await resolveAttestedRespondOutcome(reader, REQUEST_ID, RESPONSE_KEY, source, RESPONSE_KEY),
      ).toEqual({ event, serializedOutput, succeeded, matchedFailureOutput: false });
      expect(source).toHaveBeenCalledExactlyOnceWith(reader, REQUEST_ID);
    },
  );

  it("verifies fixed failure without fetching output or the consumed request", async () => {
    const event = respond(MPC_FAILURE_OUTPUT);
    const reader = arrange([event]);
    const source = vi.fn().mockRejectedValue(new Error("trace unavailable"));
    expect(
      await resolveAttestedRespondOutcome(reader, REQUEST_ID, RESPONSE_KEY, source, RESPONSE_KEY),
    ).toEqual({
      event,
      serializedOutput: MPC_FAILURE_OUTPUT,
      succeeded: false,
      matchedFailureOutput: true,
    });
    expect(source).not.toHaveBeenCalled();
    expect(vi.spyOn(reader, "getSignatureRequest")).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "wrong request",
      event: respond(TRUE_OUTPUT, OTHER_REQUEST_ID),
      key: RESPONSE_KEY,
      output: TRUE_ABI,
    },
    {
      name: "wrong signature key",
      event: respond(TRUE_OUTPUT, REQUEST_ID, OTHER_SECRET),
      key: RESPONSE_KEY,
      output: TRUE_ABI,
    },
    {
      name: "wrong pinned key",
      event: respond(TRUE_OUTPUT),
      key: secp256k1PublicKeyOf(OTHER_SECRET),
      output: TRUE_ABI,
    },
    { name: "wrong output", event: respond(TRUE_OUTPUT), key: RESPONSE_KEY, output: FALSE_ABI },
    { name: "no output", event: respond(TRUE_OUTPUT), key: RESPONSE_KEY, output: undefined },
    { name: "empty output", event: respond(TRUE_OUTPUT), key: RESPONSE_KEY, output: "0x" },
    { name: "malformed output", event: respond(TRUE_OUTPUT), key: RESPONSE_KEY, output: "0xgg" },
  ])(
    "rejects $name",
    async ({
      event,
      key,
      output,
    }: {
      event: RespondBidirectionalEvent;
      key: Secp256k1Point;
      output: string | undefined;
    }) => {
      const reader = arrange([event]);
      expect(
        await resolveAttestedRespondOutcome(
          reader,
          REQUEST_ID,
          key,
          vi.fn().mockResolvedValue(output),
        ),
      ).toBeUndefined();
    },
  );

  it("rejects a pinned key inconsistent with the configured root before fetching events or output", async () => {
    const reader = arrange([respond(MPC_FAILURE_OUTPUT, REQUEST_ID, OTHER_SECRET)]);
    const source = vi.fn().mockResolvedValue(TRUE_ABI);
    await expect(
      resolveAttestedRespondOutcome(
        reader,
        REQUEST_ID,
        secp256k1PublicKeyOf(OTHER_SECRET),
        source,
        RESPONSE_KEY,
      ),
    ).rejects.toThrow("response key");
    expect(vi.spyOn(reader, "getRespondBidirectionalEvents")).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });
});
