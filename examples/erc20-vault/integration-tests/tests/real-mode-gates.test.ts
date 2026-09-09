import * as fs from "node:fs";

import { MpcMode } from "@sig-net/midnight-examples-test-harness";
import { JsonRpcProvider } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakenetResponsesUrl, fetchFakenetResponse } from "../src/fakenet-responses.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { integrationTestInclude } from "../src/flow-selection.ts";
import { approveRouter, ensureRouterApproved } from "../src/flows/approve-router.ts";
import { approveStata, ensureStataApproved } from "../src/flows/approve-stata.ts";
import { completeRedeem, pollRedeemOutcome, settleRedeem } from "../src/flows/complete-redeem.ts";
import { completeSupply, pollSupplyOutcome, settleSupply } from "../src/flows/complete-supply.ts";
import { completeSwap, pollSwapOutcome, settleSwap } from "../src/flows/complete-swap.ts";
import { runRedeemRoundTrip } from "../src/flows/redeem-round-trip.ts";
import { startRedeem } from "../src/flows/start-redeem.ts";
import { startSupply } from "../src/flows/start-supply.ts";
import { startSwap } from "../src/flows/start-swap.ts";
import { runSupplyRoundTrip } from "../src/flows/supply-round-trip.ts";
import { runSwapRoundTrip } from "../src/flows/swap-round-trip.ts";
import { dealFork, dealForkEvmAccounts } from "../src/fork-funding.ts";
import type { VaultContext } from "../src/vault-context.ts";
import type { VaultSession } from "../src/vault-session.ts";

vi.mock("node:fs", { spy: true });

const REAL_ENV: NodeJS.ProcessEnv = { MPC_MODE: MpcMode.Real };
const REQUEST_ID = "00".repeat(32) as Parameters<typeof completeSwap>[1];
const REAL_CONTEXT = new Proxy({ mpcMode: MpcMode.Real } as VaultContext, {
  get(target, key: keyof VaultContext) {
    if (key === "mpcMode") return target.mpcMode;
    throw new Error(`context accessed before mode rejection: ${key}`);
  },
});
const REAL_SESSION = new Proxy({ mpcMode: MpcMode.Real } as VaultSession, {
  get(target, key: keyof VaultSession) {
    if (key === "mpcMode") return target.mpcMode;
    throw new Error(`session accessed before mode rejection: ${key}`);
  },
});

const BLOCKED_FLOWS: readonly {
  name: string;
  run: () => Promise<object> | Promise<string> | Promise<void>;
}[] = [
  {
    name: "runSwapRoundTrip",
    run: () => runSwapRoundTrip(REAL_SESSION, {} as Parameters<typeof runSwapRoundTrip>[1]),
  },
  { name: "runSupplyRoundTrip", run: () => runSupplyRoundTrip(REAL_SESSION, { amount: 1n }) },
  { name: "runRedeemRoundTrip", run: () => runRedeemRoundTrip(REAL_SESSION, { shares: 1n }) },
  { name: "startSwap", run: () => startSwap(REAL_CONTEXT, {} as Parameters<typeof startSwap>[1]) },
  {
    name: "startSupply",
    run: () => startSupply(REAL_CONTEXT, {} as Parameters<typeof startSupply>[1]),
  },
  {
    name: "startRedeem",
    run: () => startRedeem(REAL_CONTEXT, {} as Parameters<typeof startRedeem>[1]),
  },
  { name: "approveRouter", run: () => approveRouter(REAL_CONTEXT, 0n) },
  { name: "approveStata", run: () => approveStata(REAL_CONTEXT, 0n) },
  { name: "ensureRouterApproved", run: () => ensureRouterApproved(REAL_SESSION) },
  { name: "ensureStataApproved", run: () => ensureStataApproved(REAL_SESSION) },
  { name: "pollSwapOutcome", run: () => pollSwapOutcome(REAL_CONTEXT, { requestId: REQUEST_ID }) },
  {
    name: "pollSupplyOutcome",
    run: () => pollSupplyOutcome(REAL_CONTEXT, { requestId: REQUEST_ID }),
  },
  {
    name: "pollRedeemOutcome",
    run: () => pollRedeemOutcome(REAL_CONTEXT, { requestId: REQUEST_ID }),
  },
  {
    name: "settleSwap",
    run: () => settleSwap(REAL_CONTEXT, REQUEST_ID, {} as Parameters<typeof settleSwap>[2]),
  },
  {
    name: "settleSupply",
    run: () => settleSupply(REAL_CONTEXT, REQUEST_ID, {} as Parameters<typeof settleSupply>[2]),
  },
  {
    name: "settleRedeem",
    run: () => settleRedeem(REAL_CONTEXT, REQUEST_ID, {} as Parameters<typeof settleRedeem>[2]),
  },
  { name: "completeSwap", run: () => completeSwap(REAL_CONTEXT, REQUEST_ID) },
  { name: "completeSupply", run: () => completeSupply(REAL_CONTEXT, REQUEST_ID) },
  { name: "completeRedeem", run: () => completeRedeem(REAL_CONTEXT, REQUEST_ID) },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("real mode primitive gates", () => {
  it.each(BLOCKED_FLOWS)(
    "rejects $name before accessing the context or session",
    async ({ name, run }) => {
      vi.stubEnv("MPC_MODE", MpcMode.Fakenet);
      await expect(run()).rejects.toThrow(`${name} requires fakenet mode`);
    },
  );

  it("rejects private-key failure injection before reading its configuration", async () => {
    await expect(drainVaultErc20(REAL_ENV, "unused")).rejects.toThrow(
      "drainVaultErc20 requires fakenet mode",
    );
  });

  it("rejects fork setup before reading its configuration", async () => {
    await expect(dealForkEvmAccounts(REAL_ENV)).rejects.toThrow(
      "dealForkEvmAccounts requires fakenet mode",
    );
  });

  it("rejects direct fork dealing before any RPC call", async () => {
    const provider = new JsonRpcProvider("http://127.0.0.1:1");
    const send = vi.spyOn(provider, "send").mockRejectedValue(new Error("unexpected RPC"));
    try {
      await expect(dealFork(provider, "unused", 0n, 0n, REAL_ENV)).rejects.toThrow(
        "dealFork requires fakenet mode",
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      provider.destroy();
    }
  });

  it("rejects a direct helper API fetch before network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("unexpected fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchFakenetResponse(REQUEST_ID, 0, REAL_ENV)).rejects.toThrow(
      "fetchFakenetResponse requires fakenet mode",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

const FLOW_SELECTION_CASES: readonly {
  name: string;
  env: NodeJS.ProcessEnv;
  expected: string[] | undefined;
}[] = [
  { name: "offline default", env: {}, expected: undefined },
  { name: "offline real", env: { MPC_MODE: MpcMode.Real }, expected: undefined },
  { name: "enabled default", env: { RUN_INTEGRATION_TESTS: "1" }, expected: undefined },
  {
    name: "enabled fakenet",
    env: { RUN_INTEGRATION_TESTS: "1", MPC_MODE: MpcMode.Fakenet },
    expected: undefined,
  },
  {
    name: "enabled real bidirectional",
    env: { RUN_INTEGRATION_TESTS: "1", MPC_MODE: MpcMode.Real, REAL_MPC_STAGE: "bidirectional" },
    expected: ["tests/happy-day-e2e.test.ts"],
  },
  {
    name: "enabled real signing only",
    env: { RUN_INTEGRATION_TESTS: "1", MPC_MODE: MpcMode.Real, REAL_MPC_STAGE: "signing-only" },
    expected: ["tests/signing-only-e2e.test.ts"],
  },
];

it.each(FLOW_SELECTION_CASES)("selects supported suites for $name", ({ env, expected }) => {
  expect(integrationTestInclude(env)).toEqual(expected);
});

it("rejects an invalid mode before integration test discovery", () => {
  expect(() => integrationTestInclude({ RUN_INTEGRATION_TESTS: "1", MPC_MODE: "invalid" })).toThrow(
    "MPC_MODE must be fakenet or real",
  );
});

it.each([undefined, "", "invalid"])("rejects real stage %s before discovery", (stage) => {
  expect(() =>
    integrationTestInclude({
      RUN_INTEGRATION_TESTS: "1",
      MPC_MODE: MpcMode.Real,
      REAL_MPC_STAGE: stage,
    }),
  ).toThrow("REAL_MPC_STAGE must be signing-only or bidirectional");
});

it("uses the passed fakenet helper configuration instead of the ambient mode", async () => {
  vi.stubEnv("MPC_MODE", MpcMode.Real);
  const env: NodeJS.ProcessEnv = {
    MPC_MODE: MpcMode.Fakenet,
    FAKENET_RESPONSES_URL: "http://fake.invalid",
  };
  const cached = {
    requestId: REQUEST_ID,
    success: true,
    output: "0x01",
    txHash: "0x02",
    observedAt: "2026-09-08T00:00:00Z",
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(cached));
  vi.stubGlobal("fetch", fetch);
  expect(fakenetResponsesUrl(env)).toBe("http://fake.invalid");
  await expect(fetchFakenetResponse(REQUEST_ID, 0, env)).resolves.toEqual(cached);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`http://fake.invalid/responses/${REQUEST_ID}`);
});

const ENV_SELECTION_CASES: readonly {
  name: string;
  file: string;
  processMode: string | undefined;
  enabled: string | undefined;
  expected: string[] | undefined;
}[] = [
  {
    name: "reads real mode from the same .env as setup",
    file: "MPC_MODE=real\nREAL_MPC_STAGE=bidirectional\n",
    processMode: undefined,
    enabled: "1",
    expected: ["tests/happy-day-e2e.test.ts"],
  },
  {
    name: "process real overrides file fakenet",
    file: "MPC_MODE=fakenet\nREAL_MPC_STAGE=bidirectional\n",
    processMode: MpcMode.Real,
    enabled: "1",
    expected: ["tests/happy-day-e2e.test.ts"],
  },
  {
    name: "process fakenet overrides file real",
    file: "MPC_MODE=real\n",
    processMode: MpcMode.Fakenet,
    enabled: "1",
    expected: undefined,
  },
  {
    name: "file alone cannot enable integration setup",
    file: "MPC_MODE=real\nRUN_INTEGRATION_TESTS=1\n",
    processMode: undefined,
    enabled: undefined,
    expected: undefined,
  },
];

it.each(ENV_SELECTION_CASES)("$name", ({ file, processMode, enabled, expected }) => {
  vi.stubEnv("MPC_MODE", processMode);
  vi.stubEnv("RUN_INTEGRATION_TESTS", enabled);
  const read = vi.spyOn(fs, "readFileSync").mockReturnValueOnce(file);
  const selected = integrationTestInclude();
  expect(read).toHaveBeenCalledWith(expect.stringContaining(".env"), "utf8");
  expect(selected).toEqual(expected);
});
