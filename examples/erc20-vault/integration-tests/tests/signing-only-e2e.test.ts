import { requestIdBytes } from "@sig-net/midnight";
import { readVaultLedger } from "@sig-net/midnight-examples-erc20-vault-contract";
import { MpcMode } from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { afterAll, describe, expect, it } from "vitest";

import { RealMpcStage, resolveRealMpcStage } from "../src/real-stage.ts";
import { runSigningOnly } from "../src/signing-only.ts";
import { createVaultSession } from "../src/vault-session.ts";

const env = injectE2eEnv();
const session = createVaultSession(env);
describe.skipIf(
  !process.env.RUN_INTEGRATION_TESTS ||
    session.mpcMode !== MpcMode.Real ||
    resolveRealMpcStage(env) !== RealMpcStage.SigningOnly,
)("deployed MPC signing-only E2E", () => {
  installFlowHooks();
  afterAll(async () => {
    await session.stop();
  });
  it(
    "submits a Midnight request and verifies its exact transaction against a finalized deployed MPC Respond",
    async () => {
      const context = await session.vaultContext();
      const result = await runSigningOnly(context, env, 100000n);
      expect(result.transaction.from?.toLowerCase()).toBe(context.evmUserAddress.toLowerCase());
      expect(result.transaction.chainId).toBe(11155111n);
      expect(result.transaction.hash).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(result.provenance.respond.transactionHash).toMatch(/^(?:0x)?[0-9a-f]{64}$/u);
      expect(result.provenance.respond.blockHeight).toBeGreaterThanOrEqual(
        result.provenance.request.blockHeight,
      );
      const ledger = await readVaultLedger(
        context.providers.publicDataProvider,
        context.vaultContractAddress,
      );
      expect(ledger.depositEventMap.member(requestIdBytes(result.requestId))).toBe(true);
    },
    30 * 60_000,
  );
});
