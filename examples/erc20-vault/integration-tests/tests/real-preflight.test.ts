import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ContractOperation, ContractState } from "@midnight-ntwrk/compact-runtime";
import { parseZkArtifactManifest } from "@midnight-ntwrk/midnight-js/utils";
import { IndexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { signetContractManagedPath } from "@sig-net/midnight-contract-deploy";
import { getErc20Balance } from "@sig-net/midnight-examples-test-harness";
import { FetchRequest, JsonRpcProvider, Network, parseEther } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertRealEvmFunding, verifyRealInfrastructure } from "../src/real-preflight.ts";

vi.mock(import("@sig-net/midnight-examples-test-harness"), async (importOriginal) => ({
  ...(await importOriginal()),
  getErc20Balance: vi.fn(),
}));

const HASH = `0x${"11".repeat(32)}`;
const BLOCK_HASH = `0x${"22".repeat(32)}`;
const USER = `0x${"33".repeat(20)}`;
const VAULT = `0x${"44".repeat(20)}`;
const OUTPUT = `0x${"00".repeat(31)}01`;
const ENV: NodeJS.ProcessEnv = {
  MPC_MODE: "real",
  MPC_SECP256K1_PUBKEY: "0x02cb41bab8bc97121f4902514ca57a284f167b9239ecb8176831d1ef0fede87c61",
  NETWORK_ID: "stagenet",
  MIDNIGHT_SIGNET_CONTRACT_ADDRESS:
    "777c5ab3f79c7227e4eccab115bb5f26f31948de7992b0f2a973dd52e1b6be0f",
  EVM_CHAIN_ID: "11155111",
  EVM_RPC_URL: "https://ethereum-sepolia-rpc.publicnode.com",
  EVM_TRACE_PREFLIGHT_TX_HASH: HASH,
  EVM_USER_ADDRESS: USER,
  EVM_VAULT_ADDRESS: VAULT,
  ERC20_ADDRESS: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
};
const TX = {
  hash: HASH,
  chainId: 11155111n,
  blockHash: BLOCK_HASH,
  blockNumber: 12,
  from: USER,
  to: VAULT,
  data: "0x01020304",
};
const RECEIPT = { hash: HASH, status: 1, blockNumber: 12, blockHash: BLOCK_HASH };

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function arrange() {
  const state = new ContractState();
  const manifest = parseZkArtifactManifest(
    readFileSync(join(signetContractManagedPath, "compiler/contract-manifest.json"), "utf8"),
  );
  for (const path of manifest.files.keys()) {
    if (!path.startsWith("keys/") || !path.endsWith(".verifier")) continue;
    const operation = new ContractOperation();
    operation.verifierKey = readFileSync(join(signetContractManagedPath, path));
    state.setOperation(path.slice(5, -".verifier".length), operation);
  }
  const query = vi
    .spyOn(IndexerPublicDataProvider.prototype, "queryContractState")
    .mockResolvedValue(state);
  const dispose = vi.spyOn(IndexerPublicDataProvider.prototype, "dispose");
  vi.spyOn(JsonRpcProvider.prototype, "getNetwork").mockResolvedValue(Network.from(11155111));
  const getTransaction = vi
    .spyOn(JsonRpcProvider.prototype, "getTransaction")
    .mockResolvedValue(TX as Awaited<ReturnType<JsonRpcProvider["getTransaction"]>>);
  vi.spyOn(JsonRpcProvider.prototype, "getTransactionReceipt").mockResolvedValue(
    RECEIPT as Awaited<ReturnType<JsonRpcProvider["getTransactionReceipt"]>>,
  );
  vi.spyOn(JsonRpcProvider.prototype, "getBlock").mockResolvedValue({ hash: BLOCK_HASH } as Awaited<
    ReturnType<JsonRpcProvider["getBlock"]>
  >);
  const send = vi
    .spyOn(JsonRpcProvider.prototype, "send")
    .mockResolvedValue({ type: "CALL", from: USER, to: VAULT, input: TX.data, output: OUTPUT });
  const destroy = vi.spyOn(JsonRpcProvider.prototype, "destroy");
  const log = vi.spyOn(console, "log").mockImplementation(vi.fn());
  return { state, query, dispose, getTransaction, send, destroy, log };
}

describe("real infrastructure preflight", () => {
  it("redacts authenticated endpoint paths from successful diagnostics", async () => {
    const { log } = arrange();
    await verifyRealInfrastructure({
      ...ENV,
      EVM_RPC_URL: "https://sepolia.gateway.tenderly.co/private-api-marker",
    });
    expect(log.mock.calls.flat().join(" ")).not.toContain("private-api-marker");
    expect(log.mock.calls.flat().join(" ")).toContain("sepolia.gateway.tenderly.co");
  });

  it("redacts provider credentials from errors and their causes", async () => {
    const { send } = arrange();
    const endpoint = "https://sepolia.gateway.tenderly.co/private-api-marker";
    send.mockRejectedValue(new Error(`request failed: ${endpoint} token private-api-marker`));
    const failure = await verifyRealInfrastructure({ ...ENV, EVM_RPC_URL: endpoint }).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).not.toContain("private-api-marker");
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected preflight failure");
    expect(String(failure.cause)).not.toContain("private-api-marker");
    expect(String(failure)).toContain("request failed");
  });

  it("checks published verifier bytes and traces the explicit canonical mined transaction", async () => {
    const timeout = vi.spyOn(FetchRequest.prototype, "timeout", "set");
    const { query, dispose, send, destroy, log } = arrange();
    await verifyRealInfrastructure({ ...ENV });
    expect(query).toHaveBeenCalledExactlyOnceWith(ENV.MIDNIGHT_SIGNET_CONTRACT_ADDRESS);
    expect(send).toHaveBeenCalledExactlyOnceWith("debug_traceTransaction", [
      HASH,
      { tracer: "callTracer", tracerConfig: { onlyTopCall: true } },
    ]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join(" ")).toContain(HASH);
    expect(log.mock.calls.flat().join(" ")).toContain(OUTPUT);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it.each([undefined, "0x11", `0x${"11".repeat(64)}`])(
    "rejects invalid explicit trace hash %s before RPC",
    async (hash) => {
      const { query, send } = arrange();
      await expect(
        verifyRealInfrastructure({ ...ENV, EVM_TRACE_PREFLIGHT_TX_HASH: hash }),
      ).rejects.toThrow("EVM_TRACE_PREFLIGHT_TX_HASH");
      expect(query).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("validates configuration before any read", async () => {
    const { query, send } = arrange();
    await expect(
      verifyRealInfrastructure({ ...ENV, MPC_ROOT_KEY: "secret-marker" }),
    ).rejects.toThrow("MPC_ROOT_KEY");
    expect(query).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a changed live verifier and disposes the indexer", async () => {
    const { state, dispose, send } = arrange();
    const different = new ContractOperation();
    different.verifierKey = readFileSync(join(signetContractManagedPath, "keys/respond.verifier"));
    state.setOperation("signBidirectional", different);
    await expect(verifyRealInfrastructure({ ...ENV })).rejects.toThrow("signBidirectional");
    expect(dispose).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects absent singleton state", async () => {
    const { query, dispose, send } = arrange();
    query.mockResolvedValue(null);
    await expect(verifyRealInfrastructure({ ...ENV })).rejects.toThrow("singleton");
    expect(dispose).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a singleton missing published operations", async () => {
    const { query, dispose, send } = arrange();
    query.mockResolvedValue(new ContractState());
    await expect(verifyRealInfrastructure({ ...ENV })).rejects.toThrow("three published");
    expect(dispose).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a different RPC network before querying transactions", async () => {
    const { send, destroy, getTransaction } = arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getNetwork").mockResolvedValue(Network.from(1));
    await expect(verifyRealInfrastructure({ ...ENV })).rejects.toThrow("Sepolia 11155111");
    expect(getTransaction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing transaction", null],
    ["wrong transaction hash", { ...TX, hash: BLOCK_HASH }],
    ["wrong transaction chain", { ...TX, chainId: 1n }],
    ["unmined transaction", { ...TX, blockHash: null, blockNumber: null }],
  ])("rejects %s without tracing", async (_label, transaction) => {
    const { send, destroy } = arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getTransaction").mockResolvedValue(
      transaction as Awaited<ReturnType<JsonRpcProvider["getTransaction"]>>,
    );
    await expect(verifyRealInfrastructure({ ...ENV })).rejects.toThrow("matching mined receipt");
    expect(send).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing receipt", null],
    ["reverted", { ...RECEIPT, status: 0 }],
    ["wrong hash", { ...RECEIPT, hash: BLOCK_HASH }],
    ["wrong block", { ...RECEIPT, blockHash: HASH }],
  ])("rejects %s without tracing", async (_label, receipt) => {
    const { send, destroy } = arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getTransactionReceipt").mockResolvedValue(
      receipt as Awaited<ReturnType<JsonRpcProvider["getTransactionReceipt"]>>,
    );
    await expect(verifyRealInfrastructure({ ...ENV })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects a receipt removed from the canonical chain", async () => {
    const { send } = arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getBlock").mockResolvedValue({ hash: HASH } as Awaited<
      ReturnType<JsonRpcProvider["getBlock"]>
    >);
    await expect(verifyRealInfrastructure({ ...ENV })).rejects.toThrow("canonical");
    expect(send).not.toHaveBeenCalled();
  });

  it("stops on unavailable callTracer with endpoint and remediation", async () => {
    const { send, destroy } = arrange();
    send.mockRejectedValue(new Error("method unavailable"));
    await expect(verifyRealInfrastructure({ ...ENV })).rejects.toThrow("callTracer");
    expect(send).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects an opcode trace through the shared root-output parser", async () => {
    const { send, destroy } = arrange();
    send.mockResolvedValue({ returnValue: OUTPUT, structLogs: [] });
    await expect(verifyRealInfrastructure({ ...ENV })).rejects.toThrow("successful root call");
    expect(send).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("real EVM funding preflight", () => {
  it.each([
    ["deposit reserved", { DEPOSIT_REQUEST_ID: "aa".repeat(32) }, [VAULT]],
    [
      "both requests reserved",
      { DEPOSIT_REQUEST_ID: "aa".repeat(32), WITHDRAW_REQUEST_ID: "bb".repeat(32) },
      [],
    ],
  ])(
    "does not require spent user balances when %s",
    async (_label, checkpoint, expectedAccounts) => {
      arrange();
      const balances = vi
        .spyOn(JsonRpcProvider.prototype, "getBalance")
        .mockResolvedValue(parseEther("0.009"));
      vi.mocked(getErc20Balance).mockRejectedValue(
        new Error("spent user balance must not be queried"),
      );
      await assertRealEvmFunding({ ...ENV, ...checkpoint });
      expect(balances.mock.calls.map(([account]) => account)).toEqual(expectedAccounts);
      expect(getErc20Balance).not.toHaveBeenCalled();
    },
  );

  it("does not require vault gas again after the withdrawal is reserved", async () => {
    arrange();
    const balances = vi
      .spyOn(JsonRpcProvider.prototype, "getBalance")
      .mockResolvedValue(parseEther("0.009"));
    vi.mocked(getErc20Balance).mockResolvedValue({ balance: 100000n, decimals: 6 });
    await assertRealEvmFunding({ ...ENV, WITHDRAW_REQUEST_ID: "bb".repeat(32) });
    expect(balances).toHaveBeenCalledExactlyOnceWith(USER);
    expect(getErc20Balance).toHaveBeenCalledWith(ENV.EVM_RPC_URL, ENV.ERC20_ADDRESS, USER);
  });

  it("still requires vault gas before an unreserved withdrawal", async () => {
    arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getBalance").mockResolvedValue(0n);
    await expect(
      assertRealEvmFunding({ ...ENV, DEPOSIT_REQUEST_ID: "aa".repeat(32) }),
    ).rejects.toThrow("fund");
    expect(getErc20Balance).not.toHaveBeenCalled();
  });

  it("checks actual chain and token even when both requests were reserved", async () => {
    arrange();
    const checkpoint = {
      DEPOSIT_REQUEST_ID: "aa".repeat(32),
      WITHDRAW_REQUEST_ID: "bb".repeat(32),
    };
    vi.spyOn(JsonRpcProvider.prototype, "getNetwork").mockResolvedValue(Network.from(1));
    await expect(assertRealEvmFunding({ ...ENV, ...checkpoint })).rejects.toThrow("Sepolia");
    await expect(
      assertRealEvmFunding({ ...ENV, ...checkpoint, ERC20_ADDRESS: USER }),
    ).rejects.toThrow("USDC");
  });

  it("accepts balances exactly at the happy-day minimum", async () => {
    const { destroy } = arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getBalance").mockResolvedValue(parseEther("0.009"));
    vi.mocked(getErc20Balance).mockResolvedValue({ balance: 100000n, decimals: 6 });
    await assertRealEvmFunding({ ...ENV });
    expect(getErc20Balance).toHaveBeenCalledWith(ENV.EVM_RPC_URL, ENV.ERC20_ADDRESS, USER);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("reports exact public deficits and never submits funding", async () => {
    const { send, log } = arrange();
    vi.spyOn(JsonRpcProvider.prototype, "getBalance").mockResolvedValue(0n);
    vi.mocked(getErc20Balance).mockResolvedValue({ balance: 99999n, decimals: 6 });
    await expect(assertRealEvmFunding({ ...ENV })).rejects.toThrow("fund");
    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain(USER);
    expect(output).toContain(VAULT);
    expect(output).toContain("0.000001");
    expect(output).toContain("0.009");
    expect(send).not.toHaveBeenCalled();
  });
});
