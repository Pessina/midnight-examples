import { withSyncedWalletFacade } from "@sig-net/midnight-contract-deploy";
import { buildDeployTransactionDeferring } from "@sig-net/midnight-examples-lib";
import { expect, it, vi } from "vitest";

import { deployVault } from "../src/deploy-vault.ts";

vi.mock(import("@sig-net/midnight-contract-deploy"), async (importOriginal) => ({
  ...(await importOriginal()),
  withSyncedWalletFacade: vi.fn(() => Promise.reject(new Error("submission must not start"))),
}));

vi.mock(import("@sig-net/midnight-examples-lib"), async (importOriginal) => ({
  ...(await importOriginal()),
  buildDeployTransactionDeferring: vi.fn(),
}));

it("checkpoints the exact prepared address before any wallet or submission and honors persistence failure", async () => {
  vi.mocked(buildDeployTransactionDeferring).mockResolvedValue({
    contractAddress: "a".repeat(64),
    deferred: [],
    serializedTransaction: new Uint8Array(),
  });
  const onPrepared = vi.fn(() => {
    throw new Error("private checkpoint unavailable");
  });
  await expect(
    deployVault(
      {
        NETWORK_ID: "stagenet",
        DEPLOYER_SEED: "11".repeat(32),
        MAINTENANCE_SIGNING_KEY: "22".repeat(32),
        MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "33".repeat(32),
      },
      onPrepared,
    ),
  ).rejects.toThrow("private checkpoint unavailable");
  expect(onPrepared).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
  expect(withSyncedWalletFacade).not.toHaveBeenCalled();
});
