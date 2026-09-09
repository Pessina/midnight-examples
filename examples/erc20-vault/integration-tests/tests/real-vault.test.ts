import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ContractOperation,
  ContractState,
  createConstructorContext,
} from "@midnight-ntwrk/compact-runtime";
import {
  FailEntirely,
  type FinalizedTxData,
  SucceedEntirely,
} from "@midnight-ntwrk/midnight-js/types";
import { IndexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  ContractMaintenanceAuthority,
  ContractState as LedgerContractState,
  signatureVerifyingKey,
  signingKeyFromBip340,
} from "@midnightntwrk/ledger-v9";
import { bytesToHex, hexToBytes } from "@sig-net/midnight";
import { signetContractManagedPath } from "@sig-net/midnight-contract-deploy";
import {
  Contract,
  createVaultPrivateState,
  expectedVk,
  pureCircuits,
  witnesses,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { readDeferredCircuits } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertRealRequestCheckpoint,
  assertRealVaultBindings,
  reconcileRealRequests,
  verifyRealVault,
} from "../src/real-vault.ts";

describe("real vault bindings from the actual constructor", () => {
  it("reads the compiler-owned sealed singleton and deployer fields", async () => {
    const secret = new Uint8Array(32).fill(1);
    const singleton = new Uint8Array([7, ...new Uint8Array(31)]);
    const commitment = pureCircuits.userCommitment(secret);
    const deployed = await new Contract(witnesses).initialState(
      createConstructorContext(createVaultPrivateState(secret), "00".repeat(32)),
      commitment,
      { bytes: singleton },
    );
    expect(() => {
      assertRealVaultBindings(
        deployed.currentContractState.data,
        bytesToHex(singleton),
        commitment,
      );
    }).not.toThrow();
    expect(() => {
      assertRealVaultBindings(deployed.currentContractState.data, "88".repeat(32), commitment);
    }).toThrow("signetSigner");
    expect(() => {
      assertRealVaultBindings(
        deployed.currentContractState.data,
        bytesToHex(singleton),
        new Uint8Array(32),
      );
    }).toThrow("deployer");
  });
});

describe("real request recovery", () => {
  it.each([
    { checkpoint: false, request: false, pending: false, settled: false },
    { checkpoint: true, request: true, pending: true, settled: false },
    { checkpoint: true, request: false, pending: false, settled: true },
  ])(
    "accepts checkpoint=$checkpoint request=$request pending=$pending settled=$settled",
    ({ checkpoint, request, pending, settled }) => {
      const env = {
        DEPOSIT_REQUEST_ID: checkpoint ? "11".repeat(32) : undefined,
        REAL_DEPOSIT_SETTLED_TX_ID: settled ? "22".repeat(32) : undefined,
      };
      expect(() => {
        assertRealRequestCheckpoint(
          env,
          "DEPOSIT_REQUEST_ID",
          "REAL_DEPOSIT_SETTLED_TX_ID",
          request,
          pending,
        );
      }).not.toThrow();
    },
  );

  it.each([
    { checkpoint: false, request: true, pending: false, settled: false },
    { checkpoint: false, request: false, pending: true, settled: false },
    { checkpoint: false, request: true, pending: true, settled: false },
    { checkpoint: false, request: false, pending: false, settled: true },
    { checkpoint: false, request: true, pending: false, settled: true },
    { checkpoint: false, request: false, pending: true, settled: true },
    { checkpoint: false, request: true, pending: true, settled: true },
    { checkpoint: true, request: false, pending: false, settled: false },
    { checkpoint: true, request: true, pending: false, settled: false },
    { checkpoint: true, request: false, pending: true, settled: false },
    { checkpoint: true, request: true, pending: false, settled: true },
    { checkpoint: true, request: false, pending: true, settled: true },
    { checkpoint: true, request: true, pending: true, settled: true },
  ])(
    "rejects checkpoint=$checkpoint request=$request pending=$pending settled=$settled",
    ({ checkpoint, request, pending, settled }) => {
      const env = {
        DEPOSIT_REQUEST_ID: checkpoint ? "11".repeat(32) : undefined,
        REAL_DEPOSIT_SETTLED_TX_ID: settled ? "22".repeat(32) : undefined,
      };
      expect(() => {
        assertRealRequestCheckpoint(
          env,
          "DEPOSIT_REQUEST_ID",
          "REAL_DEPOSIT_SETTLED_TX_ID",
          request,
          pending,
        );
      }).toThrow("reconcile");
    },
  );
});

vi.mock(import("@sig-net/midnight-examples-erc20-vault-contract"), async (importOriginal) => ({
  ...(await importOriginal()),
  expectedVk: { initialise: "fixture" },
}));
vi.mock(import("@sig-net/midnight-examples-erc20-vault-deploy"), async (importOriginal) => ({
  ...(await importOriginal()),
  readDeferredCircuits: vi.fn(),
}));

const TX_ID = "22".repeat(32);
const ENV: NodeJS.ProcessEnv = {
  MPC_MODE: "real",
  MPC_SECP256K1_PUBKEY: "0x02cb41bab8bc97121f4902514ca57a284f167b9239ecb8176831d1ef0fede87c61",
  NETWORK_ID: "stagenet",
  MIDNIGHT_SIGNET_CONTRACT_ADDRESS:
    "777c5ab3f79c7227e4eccab115bb5f26f31948de7992b0f2a973dd52e1b6be0f",
  MIDNIGHT_VAULT_CONTRACT_ADDRESS: "11".repeat(32),
  EVM_CHAIN_ID: "11155111",
  EVM_RPC_URL: "https://ethereum-sepolia-rpc.publicnode.com",
  USER_SEED: "01".repeat(32),
  VAULT_USER_SECRET_KEY: "01".repeat(32),
  MAINTENANCE_SIGNING_KEY: "02".repeat(32),
};
const VERIFIER = new Uint8Array(
  readFileSync(join(signetContractManagedPath, "keys/respond.verifier")),
);

beforeEach(() => {
  delete expectedVk.startDeposit;
  expectedVk.initialise = "fixture";
  vi.mocked(readDeferredCircuits)
    .mockReset()
    .mockReturnValue([{ circuitId: "initialise", verifierKey: VERIFIER }]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function arrangeLive() {
  const secret = hexToBytes("01".repeat(32));
  const deployed = await new Contract(witnesses).initialState(
    createConstructorContext(createVaultPrivateState(secret), "00".repeat(32)),
    pureCircuits.userCommitment(secret),
    { bytes: hexToBytes("777c5ab3f79c7227e4eccab115bb5f26f31948de7992b0f2a973dd52e1b6be0f") },
  );
  const ledger = new LedgerContractState();
  ledger.data = LedgerContractState.deserialize(deployed.currentContractState.serialize()).data;
  ledger.maintenanceAuthority = new ContractMaintenanceAuthority(
    [signatureVerifyingKey(signingKeyFromBip340(hexToBytes("02".repeat(32))))],
    1,
  );
  const state = ContractState.deserialize(ledger.serialize());
  const operation = new ContractOperation();
  operation.verifierKey = VERIFIER;
  state.setOperation("initialise", operation);
  const query = vi
    .spyOn(IndexerPublicDataProvider.prototype, "queryContractState")
    .mockResolvedValue(state);
  const dispose = vi.spyOn(IndexerPublicDataProvider.prototype, "dispose");
  return { state, query, dispose };
}

describe("read-only real vault verification", () => {
  it("permits missing circuits for the resume caller", async () => {
    await arrangeLive();
    expectedVk.startDeposit = "fixture";
    expect(await verifyRealVault({ ...ENV })).toEqual(["initialise"]);
    expect(readDeferredCircuits).toHaveBeenCalledExactlyOnceWith(["initialise"]);
  });

  it("rejects an authority with additional committee members", async () => {
    const { state, query, dispose } = await arrangeLive();
    const ledger = LedgerContractState.deserialize(state.serialize());
    ledger.maintenanceAuthority = new ContractMaintenanceAuthority(
      [
        signatureVerifyingKey(signingKeyFromBip340(hexToBytes("02".repeat(32)))),
        signatureVerifyingKey(signingKeyFromBip340(hexToBytes("03".repeat(32)))),
      ],
      1,
    );
    query.mockResolvedValue(ContractState.deserialize(ledger.serialize()));
    await expect(verifyRealVault({ ...ENV })).rejects.toThrow("maintenance authority");
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("verifies bindings, the maintenance authority and installed verifier bytes", async () => {
    const { query, dispose } = await arrangeLive();
    expect(await verifyRealVault({ ...ENV })).toEqual(["initialise"]);
    expect(query).toHaveBeenCalledExactlyOnceWith(ENV.MIDNIGHT_VAULT_CONTRACT_ADDRESS);
    expect(readDeferredCircuits).toHaveBeenCalledExactlyOnceWith(["initialise"]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["missing vault", "wrong authority", "unknown operation", "wrong verifier"])(
    "rejects %s and disposes the provider",
    async (failure) => {
      const { state, query, dispose } = await arrangeLive();
      const env = { ...ENV };
      if (failure === "missing vault") query.mockResolvedValue(null);
      if (failure === "wrong authority") env.MAINTENANCE_SIGNING_KEY = "03".repeat(32);
      if (failure === "unknown operation") {
        const operation = new ContractOperation();
        operation.verifierKey = VERIFIER;
        state.setOperation("unexpected", operation);
      }
      if (failure === "wrong verifier")
        vi.mocked(readDeferredCircuits).mockReturnValue([
          { circuitId: "initialise", verifierKey: new Uint8Array([1]) },
        ]);
      await expect(verifyRealVault(env)).rejects.toThrow();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("rejects the empty skip-zk verifier table before querying", async () => {
    const { query } = await arrangeLive();
    delete expectedVk.initialise;
    await expect(verifyRealVault({ ...ENV })).rejects.toThrow("compile");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("read-only request reconciliation", () => {
  it("accepts a fresh run with empty request maps", async () => {
    const { dispose } = await arrangeLive();
    await expect(reconcileRealRequests({ ...ENV })).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("accepts consumed records only after the recorded settlement succeeds entirely", async () => {
    const { dispose } = await arrangeLive();
    const watch = vi
      .mocked(vi.spyOn(IndexerPublicDataProvider.prototype, "watchForTxData"), { partial: true })
      .mockResolvedValue({
        status: SucceedEntirely,
        txId: TX_ID,
        identifiers: [TX_ID],
      });
    await expect(
      reconcileRealRequests({
        ...ENV,
        DEPOSIT_REQUEST_ID: "33".repeat(32),
        REAL_DEPOSIT_SETTLED_TX_ID: TX_ID,
      }),
    ).resolves.toBeUndefined();
    expect(watch).toHaveBeenCalledExactlyOnceWith(TX_ID);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects a failed recorded settlement", async () => {
    const { dispose } = await arrangeLive();
    vi.mocked(vi.spyOn(IndexerPublicDataProvider.prototype, "watchForTxData"), {
      partial: true,
    }).mockResolvedValue({
      status: FailEntirely,
      txId: TX_ID,
      identifiers: [TX_ID],
    });
    await expect(
      reconcileRealRequests({
        ...ENV,
        DEPOSIT_REQUEST_ID: "33".repeat(32),
        REAL_DEPOSIT_SETTLED_TX_ID: TX_ID,
      }),
    ).rejects.toThrow("reconcile");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("bounds an unconfirmed settlement and disposes the provider", async () => {
    vi.useFakeTimers();
    const { dispose } = await arrangeLive();
    vi.spyOn(IndexerPublicDataProvider.prototype, "watchForTxData").mockReturnValue(
      new Promise<FinalizedTxData>(() => {
        /* The indexer never observes this transaction. */
      }),
    );
    const pending = (async () => {
      await expect(
        reconcileRealRequests({
          ...ENV,
          DEPOSIT_REQUEST_ID: "33".repeat(32),
          REAL_DEPOSIT_SETTLED_TX_ID: TX_ID,
        }),
      ).rejects.toThrow("reconcile");
    })();
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(dispose).toHaveBeenCalledOnce();
  });
});
