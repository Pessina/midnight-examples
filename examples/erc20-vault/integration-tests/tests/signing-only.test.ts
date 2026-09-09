import {
  asciiPadded,
  calculateRequestId,
  deriveEpsilon,
  deriveEvmAddress,
  requestIdHex,
  SECP256K1_ORDER,
  type SignBidirectionalEvent,
  signBidirectionalEventToUnsignedEvmTransaction,
  SIGNET_DEFAULT_KEY_VERSION,
  type SignetRequestResponseReader,
  TxParamType,
} from "@sig-net/midnight";
import {
  readVaultLedger,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { MpcMode } from "@sig-net/midnight-examples-test-harness";
import type * as Ethers from "ethers";
import { SigningKey } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startDeposit } from "../src/flows/start-deposit.ts";
import { VAULT_MPC_ROUTING } from "../src/mpc-routing.ts";
import { runSigningOnly, verifySignedRequest } from "../src/signing-only.ts";
import { readSigningProvenance } from "../src/signing-provenance.ts";
import { createResponseReader, type VaultContext } from "../src/vault-context.ts";
const ROOT = `0x${"01".repeat(32)}`;
const REQUEST: SignBidirectionalEvent = {
  sender: { bytes: new Uint8Array(32).fill(0x22) },
  requestNonce: 0n,
  keyVersion: SIGNET_DEFAULT_KEY_VERSION,
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
describe("signing-only exact transaction authentication", () => {
  it("accepts the exact root-derived signature", () => {
    const signer = new SigningKey(
      `0x${((BigInt(ROOT) + deriveEpsilon("22".repeat(32), "33".repeat(32))) % SECP256K1_ORDER).toString(16).padStart(64, "0")}`,
    );
    const transaction = signBidirectionalEventToUnsignedEvmTransaction(REQUEST);
    transaction.signature = signer.sign(transaction.unsignedHash);
    expect(
      verifySignedRequest(
        REQUEST,
        requestIdHex(calculateRequestId(REQUEST)),
        transaction,
        new SigningKey(ROOT).compressedPublicKey,
      ),
    ).toBe(
      deriveEvmAddress(new SigningKey(ROOT).compressedPublicKey, "22".repeat(32), "33".repeat(32)),
    );
  });
  it.each([
    { name: "different transaction nonce", nonce: 1, root: ROOT },
    { name: "different root", nonce: 0, root: `0x${"02".repeat(32)}` },
  ])("rejects $name", ({ nonce, root }) => {
    const signer = new SigningKey(
      `0x${((BigInt(ROOT) + deriveEpsilon("22".repeat(32), "33".repeat(32))) % SECP256K1_ORDER).toString(16).padStart(64, "0")}`,
    );
    const transaction = signBidirectionalEventToUnsignedEvmTransaction(REQUEST);
    transaction.nonce = nonce;
    transaction.signature = signer.sign(transaction.unsignedHash);
    expect(() =>
      verifySignedRequest(
        REQUEST,
        requestIdHex(calculateRequestId(REQUEST)),
        transaction,
        new SigningKey(root).compressedPublicKey,
      ),
    ).toThrow();
  });
});

const provider = vi.hoisted(() => ({
  getNetwork: vi.fn(),
  getCode: vi.fn(),
  getTransactionCount: vi.fn(),
  broadcastTransaction: vi.fn(),
  getBalance: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("ethers", async (original) => ({
  ...(await original<typeof Ethers>()),
  JsonRpcProvider: vi.fn(function () {
    return provider;
  }),
}));
vi.mock(import("@sig-net/midnight-examples-erc20-vault-contract"), async (original) => ({
  ...(await original()),
  readVaultLedger: vi.fn(),
}));
vi.mock(import("@sig-net/midnight-examples-erc20-vault-deploy"), async (original) => ({
  ...(await original()),
  resolveInitialiseConfig: vi.fn(),
}));
vi.mock(import("../src/flows/initialise.ts"), () => ({ initialise: vi.fn() }));
vi.mock(import("../src/flows/start-deposit.ts"), () => ({ startDeposit: vi.fn() }));
vi.mock(import("../src/flows/poll-signature-response.ts"), () => ({
  pollSignatureResponse: vi.fn(),
}));
vi.mock(import("../src/vault-context.ts"), async (original) => ({
  ...(await original()),
  createResponseReader: vi.fn(),
}));
vi.mock(import("../src/signing-provenance.ts"), () => ({ readSigningProvenance: vi.fn() }));

const PROVENANCE = {
  request: {
    eventId: 1,
    transactionHash: "aa".repeat(32),
    blockHash: "bb".repeat(32),
    blockHeight: 10,
  },
  respond: {
    eventId: 2,
    transactionHash: "cc".repeat(32),
    blockHash: "dd".repeat(32),
    blockHeight: 11,
  },
};
const PUBLIC_KEY = new SigningKey(ROOT).compressedPublicKey;
const SIGNER_ADDRESS = deriveEvmAddress(PUBLIC_KEY, "22".repeat(32), "33".repeat(32));
const CONTEXT_FIELDS = {
  mpcMode: MpcMode.Real,
  vaultContractAddress: "22".repeat(32),
  evmVaultAddress: `0x${"55".repeat(20)}`,
  evmUserAddress: SIGNER_ADDRESS,
  evmRpcUrl: "https://rpc.invalid",
  erc20Address: `0x${"44".repeat(20)}`,
  identity: { commitmentHex: "33".repeat(32) },
  providers: { publicDataProvider: {} },
};
const REQUEST_ID = requestIdHex(calculateRequestId(REQUEST));

beforeEach(() => {
  vi.clearAllMocks();
  provider.getNetwork.mockResolvedValue({ chainId: 11155111n });
  provider.getCode.mockResolvedValue("0x1234");
  provider.getTransactionCount.mockResolvedValue(0);
  vi.mocked(readVaultLedger).mockResolvedValue({
    initialised: 1n,
    evmChainId: 11155111n,
    vaultEvmAddress: new Uint8Array(20).fill(0x55),
  } as unknown as VaultLedgerState);
  vi.mocked(createResponseReader).mockReturnValue({
    getSignatureRequest: vi.fn().mockResolvedValue(REQUEST),
  } as unknown as SignetRequestResponseReader);
  vi.mocked(startDeposit).mockResolvedValue(REQUEST_ID);
  const transaction = signBidirectionalEventToUnsignedEvmTransaction(REQUEST);
  transaction.signature = new SigningKey(
    `0x${((BigInt(ROOT) + deriveEpsilon("22".repeat(32), "33".repeat(32))) % SECP256K1_ORDER).toString(16).padStart(64, "0")}`,
  ).sign(transaction.unsignedHash);
  vi.mocked(pollSignatureResponse).mockResolvedValue(transaction);
  vi.mocked(readSigningProvenance).mockResolvedValue(PROVENANCE);
});

describe("signing-only stage orchestration", () => {
  it.each([
    { name: "fresh request", saved: undefined, submits: 1 },
    { name: "saved request", saved: REQUEST_ID, submits: 0 },
  ])("verifies and preserves a $name without funding or broadcast", async ({ saved, submits }) => {
    const checkpoint = vi.fn();
    const context = { ...CONTEXT_FIELDS, checkpoint } as unknown as VaultContext;
    const result = await runSigningOnly(
      context,
      { MPC_SECP256K1_PUBKEY: PUBLIC_KEY, DEPOSIT_REQUEST_ID: saved },
      100000n,
    );
    expect(startDeposit).toHaveBeenCalledTimes(submits);
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(submits);
    expect(provider.getBalance).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(result.requestId).toBe(REQUEST_ID);
    expect(result.expectedSigner).toBe(SIGNER_ADDRESS);
    expect(result.provenance).toEqual(PROVENANCE);
    expect(checkpoint).toHaveBeenCalledWith({
      REAL_DEPOSIT_SIGNED_TRANSACTION: result.transaction.serialized,
    });
    expect(checkpoint).toHaveBeenCalledWith({
      REAL_DEPOSIT_RESPOND_PROVENANCE: JSON.stringify(PROVENANCE),
    });
    expect(pollSignatureResponse).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ requestId: REQUEST_ID, expectedSigner: SIGNER_ADDRESS }),
    );
  });
  it("stops before polling when unsigned transaction persistence fails", async () => {
    const context = {
      ...CONTEXT_FIELDS,
      checkpoint: vi.fn(() => {
        throw new Error("private journal unavailable");
      }),
    } as unknown as VaultContext;
    await expect(
      runSigningOnly(
        context,
        { MPC_SECP256K1_PUBKEY: PUBLIC_KEY, DEPOSIT_REQUEST_ID: REQUEST_ID },
        100000n,
      ),
    ).rejects.toThrow("private journal unavailable");
    expect(pollSignatureResponse).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });
});
