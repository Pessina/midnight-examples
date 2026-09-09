import {
  asciiPadded,
  bytesToHex,
  calculateRequestId,
  contractAddressFromHex,
  deriveEpsilon,
  requestIdHex,
  SECP256K1_ORDER,
  type SignBidirectionalEvent,
  signBidirectionalEventToUnsignedEvmTransaction,
  SignetRequestResponseReader,
  TxParamType,
} from "@sig-net/midnight";
import * as vaultContract from "@sig-net/midnight-examples-erc20-vault-contract";
import * as harness from "@sig-net/midnight-examples-test-harness";
import { type Block, JsonRpcProvider, Network, SigningKey, type TransactionReceipt } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { VAULT_MPC_ROUTING } from "../src/mpc-routing.ts";
import { RealMpcStage } from "../src/real-stage.ts";
import * as vaultContext from "../src/vault-context.ts";

vi.mock("@sig-net/midnight-examples-erc20-vault-contract", { spy: true });
vi.mock("@sig-net/midnight-examples-test-harness", { spy: true });
vi.mock("../src/vault-context.ts", { spy: true });

const VAULT = "11".repeat(32);
const ROOT = new SigningKey(`0x${"00".repeat(31)}01`);
const REQUEST: SignBidirectionalEvent = {
  ...VAULT_MPC_ROUTING,
  sender: contractAddressFromHex(VAULT),
  requestNonce: 0n,
  keyVersion: 1n,
  path: new Uint8Array(32).fill(0x42),
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
    calldata: { is_some: true, value: { selector: new Uint8Array(4), noWords: 0n, words: [] } },
    accessListEntryCount: 0n,
    accessList: [],
  },
};
const REQUEST_ID = requestIdHex(calculateRequestId(REQUEST));
const CHILD = new SigningKey(
  `0x${((1n + deriveEpsilon(VAULT, bytesToHex(REQUEST.path))) % SECP256K1_ORDER).toString(16).padStart(64, "0")}`,
);
const TX = signBidirectionalEventToUnsignedEvmTransaction(REQUEST);
TX.signature = CHILD.sign(TX.unsignedHash);
const CONTEXT = {
  mpcMode: harness.MpcMode.Real,
  realMpcStage: RealMpcStage.Bidirectional,
  evmRpcUrl: "https://rpc.invalid/secret-test-key",
  evmChainId: 11155111n,
  vaultContractAddress: VAULT,
  mpcPublicKey: ROOT.compressedPublicKey,
  providers: {},
} as vaultContext.VaultContext;
const OPTIONS = {
  transaction: TX,
  requestId: REQUEST_ID,
  requestsPath: vaultContract.VAULT_DEPOSIT_REQUESTS_PATH,
};
const RECEIPT = {
  hash: TX.hash,
  blockHash: "0xabc",
  blockNumber: 1,
  status: 1,
} as TransactionReceipt;

function arrange() {
  const reader = new SignetRequestResponseReader({
    requesterContractAddress: VAULT,
    requesterRequestsPath: vaultContract.VAULT_DEPOSIT_REQUESTS_PATH,
    signetContractAddress: "44".repeat(32),
    publicDataProvider: { queryContractState: () => Promise.resolve(null) },
    eventSource: { querySignetEvents: () => Promise.resolve([]) },
  });
  vi.spyOn(vaultContext, "createResponseReader").mockReturnValue(reader);
  vi.spyOn(reader, "getSignatureRequest").mockResolvedValue(REQUEST);
  const pending = {
    member: vi.fn().mockReturnValue(true),
    lookup: vi.fn().mockReturnValue({ amount: 100n }),
  };
  vi.spyOn(vaultContract, "readVaultLedger").mockResolvedValue(
    Object.assign({} as Awaited<ReturnType<typeof vaultContract.readVaultLedger>>, {
      depositSettleViews: Object.assign(
        {} as Awaited<ReturnType<typeof vaultContract.readVaultLedger>>["depositSettleViews"],
        pending,
      ),
    }),
  );
  vi.spyOn(harness, "getErc20Balance").mockResolvedValue({ balance: 100n, decimals: 6 });
  vi.spyOn(JsonRpcProvider.prototype, "getNetwork").mockResolvedValue(Network.from(11155111));
  vi.spyOn(JsonRpcProvider.prototype, "getTransactionReceipt").mockResolvedValue(null);
  vi.spyOn(JsonRpcProvider.prototype, "getTransactionCount").mockResolvedValue(0);
  vi.spyOn(JsonRpcProvider.prototype, "getBlock").mockResolvedValue({
    hash: RECEIPT.blockHash,
    baseFeePerGas: 2n,
  } as Block);
  vi.spyOn(JsonRpcProvider.prototype, "getBalance").mockResolvedValue(1_000_000n);
  const broadcast = vi
    .spyOn(JsonRpcProvider.prototype, "broadcastTransaction")
    .mockRejectedValue(new Error("BROADCAST_REACHED"));
  return { reader, pending, broadcast };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("real broadcast stage boundary", () => {
  it("rejects signing-only before reading any broadcast capability", async () => {
    const context = new Proxy(
      {
        mpcMode: harness.MpcMode.Real,
        realMpcStage: RealMpcStage.SigningOnly,
      } as vaultContext.VaultContext,
      {
        get(target, key: keyof vaultContext.VaultContext) {
          if (key === "mpcMode" || key === "realMpcStage") return target[key];
          throw new Error("capability accessed");
        },
      },
    );
    await expect(broadcastEvm(context, OPTIONS)).rejects.toThrow("bidirectional stage");
  });

  it.each([
    { name: "missing request ID", options: { ...OPTIONS, requestId: undefined } },
    { name: "missing request map", options: { ...OPTIONS, requestsPath: undefined } },
  ])("rejects $name", async ({ options }) => {
    const setup = arrange();
    await expect(broadcastEvm(CONTEXT, options)).rejects.toThrow("exact request");
    expect(setup.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a missing request from the fresh SDK reader", async () => {
    const setup = arrange();
    vi.spyOn(setup.reader, "getSignatureRequest").mockRejectedValue(new Error("request absent"));
    await expect(broadcastEvm(CONTEXT, OPTIONS)).rejects.toThrow("request absent");
    expect(setup.broadcast).not.toHaveBeenCalled();
  });

  it("preserves fakenet broadcasting without real request prerequisites", async () => {
    const setup = arrange();
    await expect(
      broadcastEvm({ ...CONTEXT, mpcMode: harness.MpcMode.Fakenet }, { transaction: TX }),
    ).rejects.toThrow("BROADCAST_REACHED");
    expect(setup.broadcast).toHaveBeenCalledExactlyOnceWith(TX.serialized);
    expect(vi.spyOn(vaultContext, "createResponseReader")).not.toHaveBeenCalled();
  });

  it.each([
    { name: "latest nonce consumed", latest: 1, pending: 1 },
    { name: "pending nonce occupied", latest: 0, pending: 1 },
    { name: "nonce gap", latest: 0, pending: 0, nonce: 1 },
  ])("rejects $name before broadcasting", async ({ latest, pending, nonce }) => {
    const setup = arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getTransactionCount").mockImplementation((_address, tag) =>
      Promise.resolve(tag === "latest" ? latest : pending),
    );
    const transaction = TX.clone();
    if (nonce !== undefined) {
      transaction.nonce = nonce;
      transaction.signature = CHILD.sign(transaction.unsignedHash);
      vi.spyOn(setup.reader, "getSignatureRequest").mockResolvedValue({
        ...REQUEST,
        txParams: { ...REQUEST.txParams, nonce: BigInt(nonce) },
      });
    }
    await expect(broadcastEvm(CONTEXT, { ...OPTIONS, transaction })).rejects.toThrow("nonce");
    expect(setup.broadcast).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "wrong chain",
      change: () =>
        vi.spyOn(JsonRpcProvider.prototype, "getNetwork").mockResolvedValue(Network.from(1)),
      error: "Sepolia",
    },
    {
      name: "stale fee cap",
      change: () =>
        vi
          .spyOn(JsonRpcProvider.prototype, "getBlock")
          .mockResolvedValue({ baseFeePerGas: 11n } as Block),
      error: "fee",
    },
    {
      name: "insufficient native balance",
      change: () => vi.spyOn(JsonRpcProvider.prototype, "getBalance").mockResolvedValue(999_999n),
      error: "ETH",
    },
    {
      name: "insufficient token balance",
      change: () =>
        vi.spyOn(harness, "getErc20Balance").mockResolvedValue({ balance: 99n, decimals: 6 }),
      error: "token",
    },
  ])("rejects $name before broadcasting", async ({ change, error }) => {
    const setup = arrange();
    change();
    await expect(broadcastEvm(CONTEXT, OPTIONS)).rejects.toThrow(error);
    expect(setup.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a request without its pending settlement record", async () => {
    const setup = arrange();
    setup.pending.member.mockReturnValue(false);
    await expect(broadcastEvm(CONTEXT, OPTIONS)).rejects.toThrow("pending");
    expect(setup.broadcast).not.toHaveBeenCalled();
  });

  it.each(["changed transaction", "wrong signer"])("rejects %s", async (variation) => {
    const setup = arrange();
    const transaction = TX.clone();
    if (variation === "changed transaction") transaction.value = 1n;
    transaction.signature = (variation === "wrong signer" ? ROOT : CHILD).sign(
      transaction.unsignedHash,
    );
    await expect(broadcastEvm(CONTEXT, { ...OPTIONS, transaction })).rejects.toThrow("request");
    expect(setup.broadcast).not.toHaveBeenCalled();
  });

  it("admits a current fully funded exact transaction to the broadcast edge", async () => {
    const setup = arrange();
    await expect(broadcastEvm(CONTEXT, OPTIONS)).rejects.toThrow("BROADCAST_REACHED");
    expect(setup.broadcast).toHaveBeenCalledExactlyOnceWith(TX.serialized);
  });

  it("resumes only a canonically mined matching receipt without funding or resend", async () => {
    const setup = arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getTransactionReceipt").mockResolvedValue(RECEIPT);
    expect(await broadcastEvm(CONTEXT, OPTIONS)).toBe(RECEIPT);
    expect(setup.broadcast).not.toHaveBeenCalled();
    expect(vi.spyOn(JsonRpcProvider.prototype, "getBalance")).not.toHaveBeenCalled();
  });

  it("rejects a noncanonical receipt", async () => {
    const setup = arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getTransactionReceipt").mockResolvedValue({
      hash: RECEIPT.hash,
      blockNumber: RECEIPT.blockNumber,
      status: 1,
      blockHash: "0xdef",
    } as TransactionReceipt);
    await expect(broadcastEvm(CONTEXT, OPTIONS)).rejects.toThrow("canonical");
    expect(setup.broadcast).not.toHaveBeenCalled();
  });
});
