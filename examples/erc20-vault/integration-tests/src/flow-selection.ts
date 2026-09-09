import { buildBaseEnv } from "@sig-net/midnight-examples-lib/env-file";
import { MpcMode, resolveMpcMode } from "@sig-net/midnight-examples-test-harness/mpc-mode";

import { RealMpcStage, resolveRealMpcStage } from "./real-stage.ts";

/**
 * Restrict real integration runs to the explicitly selected live stage.
 *
 * @param env - The merged entrypoint configuration; defaults to the setup pipeline's
 *   environment with the executable's integration opt-in.
 * @returns The selected real suite, or undefined to retain Vitest's default discovery.
 * @throws {Error} If an enabled integration run specifies an unsupported MPC mode or real stage.
 */
export function integrationTestInclude(
  env: NodeJS.ProcessEnv = {
    ...buildBaseEnv(),
    RUN_INTEGRATION_TESTS: process.env.RUN_INTEGRATION_TESTS,
  },
): string[] | undefined {
  if (!env.RUN_INTEGRATION_TESTS) return undefined;
  if (resolveMpcMode(env) !== MpcMode.Real) return undefined;
  return resolveRealMpcStage(env) === RealMpcStage.SigningOnly
    ? ["tests/signing-only-e2e.test.ts"]
    : ["tests/happy-day-e2e.test.ts"];
}
