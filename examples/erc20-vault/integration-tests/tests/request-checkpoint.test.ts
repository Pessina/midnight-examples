import type * as Signet from "@sig-net/midnight";
import {
  asciiPadded,
  bytesToHex,
  calculateRequestId,
  MPC_FAILURE_OUTPUT,
  parseRequestIdHex,
  requestIdHex,
  signBidirectionalEventToUnsignedEvmTransaction,
} from "@sig-net/midnight";
import { signatureToSignatureRespondedEvent } from "@sig-net/midnight/testing";
import type * as VaultContract from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  readVaultLedger,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { MpcMode } from "@sig-net/midnight-examples-test-harness";
import { SigningKey } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settleDeposit } from "../src/flows/complete-deposit.ts";
import { settleWithdraw } from "../src/flows/complete-withdraw.ts";
import type { RespondOutcome } from "../src/flows/respond-output.ts";
import { startDeposit } from "../src/flows/start-deposit.ts";
import { startWithdraw } from "../src/flows/start-withdraw.ts";
import type { VaultContext } from "../src/vault-context.ts";

vi.mock("@sig-net/midnight", async (importOriginal) => {
  const sdk = await importOriginal<typeof Signet>();
  return { ...sdk, calculateRequestId: vi.fn(sdk.calculateRequestId) };
});

vi.mock("@sig-net/midnight-examples-erc20-vault-contract", async (importOriginal) => ({
  ...(await importOriginal<typeof VaultContract>()),
  readVaultLedger: vi.fn(),
}));

const REQUEST_ID = parseRequestIdHex("33".repeat(32));
const TX_ID = "44".repeat(32);
const BEFORE_LEDGER = {
  initialised: 1n,
  signetRequestNonce: 0n,
  vaultEvmAddress: new Uint8Array(20).fill(0x22),
  caip2Id: asciiPadded("eip155:11155111", 32),
  evmChainId: 11155111n,
} as VaultLedgerState;
const CONTEXT_FIELDS = {
  mpcMode: MpcMode.Real,
  vaultContractAddress: "11".repeat(32),
  erc20Address: `0x${"22".repeat(20)}`,
  providers: { publicDataProvider: {} },
  identity: {
    secretKey: new Uint8Array(32).fill(0x01),
    commitment: new Uint8Array(32).fill(0x02),
    commitmentHex: "02".repeat(32),
  },
};
const SUCCESS: RespondOutcome = {
  event: signatureToSignatureRespondedEvent(
    new SigningKey(`0x${"01".repeat(32)}`).sign(`0x${"00".repeat(32)}`),
  ),
  serializedOutput: new Uint8Array([1]),
  succeeded: true,
  matchedFailureOutput: false,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("request producer checkpoints", () => {
  it.each([
    {
      name: "deposit",
      key: "DEPOSIT_REQUEST_ID",
      run: (context: VaultContext) => startDeposit(context, { amount: 1n, evmNonce: 0n }),
    },
    {
      name: "withdraw",
      key: "WITHDRAW_REQUEST_ID",
      run: (context: VaultContext) =>
        startWithdraw(context, {
          amount: 1n,
          evmNonce: 0n,
          destEvmAddress: `0x${"55".repeat(20)}`,
        }),
    },
  ])(
    "reserves the $name ID before submission and honors persistence failure",
    async ({ key, run }) => {
      vi.mocked(readVaultLedger).mockResolvedValue(BEFORE_LEDGER);
      const submit = vi.fn(() => Promise.reject(new Error("submission must not start")));
      const checkpoint = vi.fn(() => {
        throw new Error("private checkpoint unavailable");
      });
      const context = {
        ...CONTEXT_FIELDS,
        checkpoint,
        vault: { callTx: { startDeposit: submit, startWithdraw: submit } },
      } as unknown as VaultContext;
      await expect(run(context)).rejects.toThrow("private checkpoint unavailable");
      expect(calculateRequestId).toHaveBeenCalledOnce();
      const computed = vi.mocked(calculateRequestId).mock.results.at(0);
      if (computed?.type !== "return") throw new Error("flow did not compute a request ID");
      const record = vi.mocked(calculateRequestId).mock.calls.at(0)?.at(0);
      if (!record) throw new Error("flow did not expose the expected record to the SDK");
      expect(checkpoint).toHaveBeenCalledExactlyOnceWith(
        key === "DEPOSIT_REQUEST_ID"
          ? {
              [key]: requestIdHex(computed.value),
              REAL_DEPOSIT_UNSIGNED_TRANSACTION:
                signBidirectionalEventToUnsignedEvmTransaction(record).unsignedSerialized,
              REAL_DEPOSIT_KEY_VERSION: String(record.keyVersion),
              REAL_DEPOSIT_PATH: bytesToHex(record.path),
              REAL_DEPOSIT_REQUESTER: bytesToHex(record.sender.bytes),
            }
          : { [key]: requestIdHex(computed.value) },
      );
      expect(submit).not.toHaveBeenCalled();
    },
  );
});

describe("settlement checkpoint evidence", () => {
  it("returns the deposit settlement transaction ID", async () => {
    const submit = vi.fn(() => Promise.resolve({ public: { txId: TX_ID } }));
    const context = {
      ...CONTEXT_FIELDS,
      vault: { callTx: { completeDeposit: submit } },
    } as unknown as VaultContext;
    await expect(settleDeposit(context, REQUEST_ID, SUCCESS)).resolves.toBe(TX_ID);
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "executed true", outcome: SUCCESS, circuit: "completeWithdraw" },
    {
      name: "executed false",
      outcome: { ...SUCCESS, serializedOutput: new Uint8Array([0]), succeeded: false },
      circuit: "completeWithdraw",
    },
    {
      name: "MPC failure",
      outcome: {
        ...SUCCESS,
        serializedOutput: MPC_FAILURE_OUTPUT,
        succeeded: false,
        matchedFailureOutput: true,
      },
      circuit: "refundWithdraw",
    },
  ])("returns the $name withdrawal settlement transaction ID", async ({ outcome, circuit }) => {
    const completeWithdraw = vi.fn(() => Promise.resolve({ public: { txId: TX_ID } }));
    const refundWithdraw = vi.fn(() => Promise.resolve({ public: { txId: TX_ID } }));
    const callTx = { completeWithdraw, refundWithdraw };
    const context = { ...CONTEXT_FIELDS, vault: { callTx } } as unknown as VaultContext;
    await expect(settleWithdraw(context, REQUEST_ID, outcome)).resolves.toBe(TX_ID);
    expect(callTx[circuit as keyof typeof callTx]).toHaveBeenCalledOnce();
    expect(completeWithdraw.mock.calls.length + refundWithdraw.mock.calls.length).toBe(1);
  });
});
