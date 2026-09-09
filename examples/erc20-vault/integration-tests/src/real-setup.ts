import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeSha256Hex,
  parseZkArtifactManifest,
  validatePassword,
  verifyZkArtifactIntegrity,
} from "@midnight-ntwrk/midnight-js/utils";
import { bytesToHex } from "@sig-net/midnight";
import { envOrUndefined, generateHexSeed } from "@sig-net/midnight-contract-deploy";
import { expectedVk } from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  deployVault,
  resumeVaultDeploy,
  VAULT_MANAGED_PATH,
} from "@sig-net/midnight-examples-erc20-vault-deploy";
import { configureRealMpc, requireEnv } from "@sig-net/midnight-examples-test-harness";

import { saveRealState } from "./real-state.ts";
import { verifyRealVault } from "./real-vault.ts";
import { resolveUserIdentity } from "./vault-identity.ts";

/**
 * Verify the compiled artifacts before funding and pin them to the private run.
 *
 * @param env - Real-run environment.
 * @throws {Error} If proving keys are absent, corrupted or differ from a resumed run.
 */
export function verifyRealArtifacts(env: NodeJS.ProcessEnv): void {
  if (Object.keys(expectedVk).length === 0) {
    throw new Error(
      "run yarn compile:erc20-vault:zk before starting real E2E; proving keys are absent",
    );
  }
  const serialized = readFileSync(join(VAULT_MANAGED_PATH, "compiler/contract-manifest.json"));
  const manifest = parseZkArtifactManifest(serialized.toString("utf8"));
  for (const relativePath of manifest.files.keys()) {
    verifyZkArtifactIntegrity({
      manifest,
      relativePath,
      bytes: readFileSync(join(VAULT_MANAGED_PATH, relativePath)),
      mode: "require",
    });
  }
  saveRealState(env, { REAL_ARTIFACT_DIGEST: computeSha256Hex(serialized) });
}

/**
 * Persist both fee-wallet identities and the maintenance key before they are used.
 *
 * @param env - Validated public configuration and explicit funded ROOT_SEED.
 * @throws {Error} If root is absent, configuration conflicts, or checkpoint cannot be written.
 */
export function prepareRealRoles(env: NodeJS.ProcessEnv): void {
  requireEnv(env, "ROOT_SEED");
  configureRealMpc(env);
  const next = { ...env };
  for (const key of ["DEPLOYER_SEED", "USER_SEED", "MAINTENANCE_SIGNING_KEY"]) {
    next[key] = envOrUndefined(next, key) ?? generateHexSeed();
  }
  next.VAULT_DEPLOYER_SECRET_KEY =
    envOrUndefined(next, "VAULT_DEPLOYER_SECRET_KEY") ??
    bytesToHex(resolveUserIdentity(next).secretKey);
  // Separators break the password validator's four-character sequential patterns.
  next.PRIVATE_STORAGE_PASSWORD =
    envOrUndefined(next, "PRIVATE_STORAGE_PASSWORD") ??
    `P!7-${
      randomBytes(32)
        .toString("hex")
        .match(/.{1,3}/gu)
        ?.join("-") ?? ""
    }`;
  validatePassword(requireEnv(next, "PRIVATE_STORAGE_PASSWORD"));
  configureRealMpc(next);
  saveRealState(next);
  Object.assign(env, next);
}

/**
 * Deploy once, or verify and finish the privately reserved split deployment.
 *
 * @param env - Private real-run environment with verified compiled artifacts.
 * @throws {Error} If a reserved address is absent/foreign, or submission/maintenance fails.
 */
export async function deployRealVault(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
    await verifyRealVault(env);
    await resumeVaultDeploy(env);
  } else {
    await deployVault(env, (address) => {
      saveRealState(env, { MIDNIGHT_VAULT_CONTRACT_ADDRESS: address });
    });
  }
  const installed = await verifyRealVault(env);
  if (installed.length !== Object.keys(expectedVk).length) {
    throw new Error("real vault deployment is incomplete; retain its checkpoint and resume");
  }
}
