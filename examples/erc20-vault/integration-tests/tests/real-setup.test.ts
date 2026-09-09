import { generateHexSeed } from "@sig-net/midnight-contract-deploy";
import { deployVault } from "@sig-net/midnight-examples-erc20-vault-deploy";
import { buildBaseEnv } from "@sig-net/midnight-examples-lib";
import {
  assertEnvironment,
  compileContractZk,
  deploySignetContractStep,
  ensureMpcRootKey,
  ensureMpcSecp256k1Pubkey,
  ensureWalletSeeds,
  ensureWalletsFunded,
  persistFakenetHandoffToDotEnv,
  printMpcServerConfig,
  resolveEvmChain,
  startFakenetResponder,
} from "@sig-net/midnight-examples-test-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";

import { stataAvailable } from "../src/evm-stata.ts";
import { uniswapAvailable } from "../src/evm-swap.ts";
import { dealForkEvmAccounts } from "../src/fork-funding.ts";
import { assertRealEvmFunding, verifyRealInfrastructure } from "../src/real-preflight.ts";
import { deployRealVault, prepareRealRoles, verifyRealArtifacts } from "../src/real-setup.ts";
import { acquireRealRunLock, loadRealState, saveRealState } from "../src/real-state.ts";
import { reconcileRealRequests } from "../src/real-vault.ts";
import { setup } from "../src/setup.ts";

vi.mock(import("node:crypto"), async (original) => ({
  ...(await original()),
  randomBytes: vi.fn((size: number) =>
    Buffer.from("0d917ca63fb852e407da695c18bf2063e4d8a5197bc02ef6548c31a79ed05b62", "hex").subarray(
      0,
      size,
    ),
  ),
}));
vi.mock(import("@sig-net/midnight-contract-deploy"), async (original) => ({
  ...(await original()),
  generateHexSeed: vi.fn(),
}));
vi.mock(import("@sig-net/midnight-examples-erc20-vault-deploy"), async (original) => ({
  ...(await original()),
  deployVault: vi.fn(),
}));
vi.mock(import("@sig-net/midnight-examples-lib"), async (original) => ({
  ...(await original()),
  buildBaseEnv: vi.fn(),
}));
vi.mock(import("@sig-net/midnight-examples-test-harness"), async (original) => ({
  ...(await original()),
  assertEnvironment: vi.fn(),
  compileContractZk: vi.fn(),
  deploySignetContractStep: vi.fn(),
  ensureMpcResponseKey: vi.fn(),
  ensureMpcRootKey: vi.fn(),
  ensureMpcSecp256k1Pubkey: vi.fn(),
  ensureWalletSeeds: vi.fn(),
  ensureWalletsFunded: vi.fn(),
  persistFakenetHandoffToDotEnv: vi.fn(),
  printMpcServerConfig: vi.fn(),
  resolveEvmChain: vi.fn(),
  startFakenetResponder: vi.fn(),
}));
vi.mock(import("../src/real-preflight.ts"), () => ({
  verifyRealInfrastructure: vi.fn(),
  assertRealEvmFunding: vi.fn(),
}));
vi.mock(import("../src/real-setup.ts"), async (original) => ({
  ...(await original()),
  verifyRealArtifacts: vi.fn(),
  deployRealVault: vi.fn(),
}));
vi.mock(import("../src/real-state.ts"), async (original) => ({
  ...(await original()),
  acquireRealRunLock: vi.fn(),
  loadRealState: vi.fn(),
  saveRealState: vi.fn(),
}));
vi.mock(import("../src/real-vault.ts"), () => ({
  reconcileRealRequests: vi.fn(),
  verifyRealVault: vi.fn(),
}));
vi.mock(import("../src/fork-funding.ts"), async (original) => ({
  ...(await original()),
  dealForkEvmAccounts: vi.fn(),
}));
vi.mock(import("../src/evm-stata.ts"), async (original) => ({
  ...(await original()),
  stataAvailable: vi.fn(),
}));
vi.mock(import("../src/evm-swap.ts"), async (original) => ({
  ...(await original()),
  uniswapAvailable: vi.fn(),
}));

const ENV: NodeJS.ProcessEnv = {
  MPC_MODE: "real",
  REAL_MPC_STAGE: "bidirectional",
  NETWORK_ID: "stagenet",
  EVM_CHAIN_ID: "11155111",
  EVM_RPC_URL: "https://ethereum-sepolia-rpc.publicnode.com",
  MPC_SECP256K1_PUBKEY: "0x02cb41bab8bc97121f4902514ca57a284f167b9239ecb8176831d1ef0fede87c61",
  MIDNIGHT_SIGNET_CONTRACT_ADDRESS:
    "777c5ab3f79c7227e4eccab115bb5f26f31948de7992b0f2a973dd52e1b6be0f",
  ROOT_SEED: "aa".repeat(32),
  PRIVATE_STORAGE_PASSWORD: "Q!7-k9f-d8e-q2r-n3t-p4u-g6h-z1c",
};
const EVENTS: string[] = [];
const RELEASE = vi.fn<() => void>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RUN_INTEGRATION_TESTS", "1");
  vi.stubEnv("STEP_THROUGH", "");
  vi.spyOn(console, "log").mockImplementation(vi.fn());
  EVENTS.length = 0;
  RELEASE.mockImplementation(() => {
    EVENTS.push("release");
  });
  vi.mocked(buildBaseEnv).mockReturnValue({ ...ENV });
  vi.mocked(acquireRealRunLock).mockImplementation(() => {
    EVENTS.push("lock");
    return RELEASE;
  });
  vi.mocked(loadRealState).mockImplementation((env) => {
    EVENTS.push("load");
    return { ...env };
  });
  vi.mocked(verifyRealInfrastructure)
    .mockReset()
    .mockImplementation(() => {
      EVENTS.push("infrastructure");
      return Promise.resolve();
    });
  vi.mocked(assertEnvironment).mockImplementation(() => {
    EVENTS.push("environment");
    return Promise.resolve();
  });
  vi.mocked(verifyRealArtifacts).mockImplementation(() => {
    EVENTS.push("artifacts");
  });
  vi.mocked(generateHexSeed)
    .mockReset()
    .mockReturnValueOnce("11".repeat(32))
    .mockReturnValueOnce("22".repeat(32))
    .mockReturnValueOnce("33".repeat(32));
  vi.mocked(saveRealState)
    .mockReset()
    .mockImplementation(() => {
      EVENTS.push("save");
    });
  vi.mocked(ensureWalletsFunded)
    .mockReset()
    .mockImplementation(() => {
      EVENTS.push("fund");
      return Promise.resolve();
    });
  vi.mocked(deployRealVault).mockImplementation((env) => {
    EVENTS.push("deploy");
    env.MIDNIGHT_VAULT_CONTRACT_ADDRESS = "44".repeat(32);
    return Promise.resolve();
  });
  vi.mocked(reconcileRealRequests).mockImplementation(() => {
    EVENTS.push("reconcile");
    return Promise.resolve();
  });
  vi.mocked(assertRealEvmFunding).mockImplementation(() => {
    EVENTS.push("evm funding");
    return Promise.resolve();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("actual real setup pipeline", () => {
  it("omits only EVM funding for the signing-only stage", async () => {
    vi.mocked(buildBaseEnv).mockReturnValue({ ...ENV, REAL_MPC_STAGE: "signing-only" });
    const provide = vi.fn<TestProject["provide"]>();
    const release = await setup({ provide });
    expect(EVENTS).toEqual([
      "lock",
      "load",
      "infrastructure",
      "environment",
      "artifacts",
      "save",
      "fund",
      "deploy",
      "save",
      "reconcile",
    ]);
    expect(assertRealEvmFunding).not.toHaveBeenCalled();
    expect(provide).toHaveBeenCalledWith(
      "e2eEnv",
      expect.objectContaining({ REAL_MPC_STAGE: "signing-only" }),
    );
    expect(startFakenetResponder).not.toHaveBeenCalled();
    expect(dealForkEvmAccounts).not.toHaveBeenCalled();
    if (release === undefined) throw new Error("setup did not return its lock teardown");
    release();
  });

  it.each([undefined, "", "invalid"])(
    "rejects real stage %s before acquiring a run lock",
    async (stage) => {
      vi.mocked(buildBaseEnv).mockReturnValue({ ...ENV, REAL_MPC_STAGE: stage });
      const provide = vi.fn<TestProject["provide"]>();
      await expect(setup({ provide })).rejects.toThrow(
        "REAL_MPC_STAGE must be signing-only or bidirectional",
      );
      expect(acquireRealRunLock).not.toHaveBeenCalled();
      expect(verifyRealInfrastructure).not.toHaveBeenCalled();
      expect(ensureWalletsFunded).not.toHaveBeenCalled();
    },
  );

  it("is an offline no-op before configuration or checkpoint access", async () => {
    vi.stubEnv("RUN_INTEGRATION_TESTS", "");
    const provide = vi.fn<TestProject["provide"]>();
    await expect(setup({ provide })).resolves.toBeUndefined();
    expect(buildBaseEnv).not.toHaveBeenCalled();
    expect(acquireRealRunLock).not.toHaveBeenCalled();
    expect(verifyRealInfrastructure).not.toHaveBeenCalled();
    expect(ensureWalletsFunded).not.toHaveBeenCalled();
    expect(provide).not.toHaveBeenCalled();
  });

  it("stops at failed infrastructure before local services, identity generation, funding or deployment", async () => {
    vi.mocked(verifyRealInfrastructure).mockImplementation(() => {
      EVENTS.push("infrastructure");
      throw new Error("trace unavailable");
    });
    const provide = vi.fn<TestProject["provide"]>();
    await expect(setup({ provide })).rejects.toThrow("trace unavailable");
    expect(EVENTS).toEqual(["lock", "load", "infrastructure", "release"]);
    for (const action of [
      assertEnvironment,
      verifyRealArtifacts,
      generateHexSeed,
      saveRealState,
      ensureWalletsFunded,
      deployRealVault,
      deployVault,
      compileContractZk,
      ensureWalletSeeds,
      ensureMpcRootKey,
      ensureMpcSecp256k1Pubkey,
      deploySignetContractStep,
      persistFakenetHandoffToDotEnv,
      startFakenetResponder,
      printMpcServerConfig,
      resolveEvmChain,
      dealForkEvmAccounts,
      stataAvailable,
      uniswapAvailable,
      assertRealEvmFunding,
    ]) {
      expect(action).not.toHaveBeenCalled();
    }
    expect(provide).not.toHaveBeenCalled();
  });

  it("persists roles before funding, reconciles before EVM funding and transfers only worker credentials", async () => {
    vi.mocked(ensureWalletsFunded).mockImplementation((env, roles) => {
      expect(EVENTS.at(-1)).toBe("save");
      expect(env.DEPLOYER_SEED).toBe("11".repeat(32));
      expect(env.USER_SEED).toBe("22".repeat(32));
      expect(roles).toEqual([
        { label: "deployer", envVar: "DEPLOYER_SEED" },
        { label: "user", envVar: "USER_SEED" },
      ]);
      EVENTS.push("fund");
      return Promise.resolve();
    });
    const provide = vi.fn<TestProject["provide"]>();
    const release = await setup({ provide });
    expect(EVENTS).toEqual([
      "lock",
      "load",
      "infrastructure",
      "environment",
      "artifacts",
      "save",
      "fund",
      "deploy",
      "save",
      "reconcile",
      "evm funding",
    ]);
    expect(provide).toHaveBeenCalledWith(
      "e2eEnv",
      expect.objectContaining({ DEPLOYER_SEED: "11".repeat(32), USER_SEED: "22".repeat(32) }),
    );
    expect(provide.mock.calls[0]?.[1]).not.toHaveProperty("ROOT_SEED");
    expect(provide.mock.calls[0]?.[1]).not.toHaveProperty("MAINTENANCE_SIGNING_KEY");
    expect(RELEASE).not.toHaveBeenCalled();
    expect(release).toBe(RELEASE);
    if (release === undefined) throw new Error("setup did not return its lock teardown");
    release();
    expect(RELEASE).toHaveBeenCalledOnce();
    expect(dealForkEvmAccounts).not.toHaveBeenCalled();
    expect(startFakenetResponder).not.toHaveBeenCalled();
  });

  it("does not fund when persisting generated identities fails", async () => {
    vi.mocked(saveRealState).mockImplementation(() => {
      throw new Error("checkpoint unwritable");
    });
    const provide = vi.fn<TestProject["provide"]>();
    await expect(setup({ provide })).rejects.toThrow("checkpoint unwritable");
    expect(ensureWalletsFunded).not.toHaveBeenCalled();
    expect(deployRealVault).not.toHaveBeenCalled();
    expect(RELEASE).toHaveBeenCalledOnce();
    expect(provide).not.toHaveBeenCalled();
  });
});

describe("actual prepareRealRoles", () => {
  it("generates optional identities and password when copied environment fields are blank", () => {
    const env: NodeJS.ProcessEnv = {
      ...ENV,
      DEPLOYER_SEED: "",
      USER_SEED: "",
      MAINTENANCE_SIGNING_KEY: "",
      VAULT_DEPLOYER_SECRET_KEY: "",
      PRIVATE_STORAGE_PASSWORD: "",
    };
    prepareRealRoles(env);
    expect(env).toMatchObject({
      DEPLOYER_SEED: "11".repeat(32),
      USER_SEED: "22".repeat(32),
      MAINTENANCE_SIGNING_KEY: "33".repeat(32),
      VAULT_DEPLOYER_SECRET_KEY: "22".repeat(32),
    });
    expect(env.PRIVATE_STORAGE_PASSWORD).toMatch(/^P!7-/u);
    expect(saveRealState).toHaveBeenCalledExactlyOnceWith(env);
  });
  it("writes all identity inputs before exposing them to the caller, then reuses them", () => {
    const env: NodeJS.ProcessEnv = { ...ENV };
    vi.mocked(saveRealState).mockImplementation((next) => {
      expect(env).not.toHaveProperty("DEPLOYER_SEED");
      expect(next).toMatchObject({
        DEPLOYER_SEED: "11".repeat(32),
        USER_SEED: "22".repeat(32),
        MAINTENANCE_SIGNING_KEY: "33".repeat(32),
        VAULT_DEPLOYER_SECRET_KEY: "22".repeat(32),
      });
    });
    prepareRealRoles(env);
    const saved = { ...env };
    vi.mocked(saveRealState).mockImplementation(vi.fn());
    vi.mocked(generateHexSeed).mockClear();
    prepareRealRoles(env);
    expect(env).toEqual(saved);
    expect(generateHexSeed).not.toHaveBeenCalled();
    expect(saveRealState).toHaveBeenLastCalledWith(saved);
  });

  it("leaves the caller unchanged when identity persistence fails", () => {
    const env: NodeJS.ProcessEnv = { ...ENV };
    vi.mocked(saveRealState).mockImplementation(() => {
      throw new Error("checkpoint unwritable");
    });
    expect(() => {
      prepareRealRoles(env);
    }).toThrow("checkpoint unwritable");
    expect(env).toEqual(ENV);
    expect(ensureWalletsFunded).not.toHaveBeenCalled();
  });
});
