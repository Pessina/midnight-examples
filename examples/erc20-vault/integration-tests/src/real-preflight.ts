import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseZkArtifactManifest,
  verifyZkArtifactIntegrity,
} from "@midnight-ntwrk/midnight-js/utils";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  getMidnightNodeConfig,
  signetContractManagedPath,
} from "@sig-net/midnight-contract-deploy";
import {
  configureRealMpc,
  getErc20Balance,
  requireEnv,
} from "@sig-net/midnight-examples-test-harness";
import {
  FetchRequest,
  formatEther,
  formatUnits,
  JsonRpcProvider,
  parseEther,
  parseUnits,
} from "ethers";

import { parseCallTracerOutput, redactRpcDiagnostic } from "./evm-output.ts";
import { SEPOLIA_USDC } from "./fork-funding.ts";

function boundedEvmProvider(env: NodeJS.ProcessEnv): JsonRpcProvider {
  const connection = new FetchRequest(requireEnv(env, "EVM_RPC_URL"));
  connection.timeout = 10_000;
  return new JsonRpcProvider(connection, undefined, { batchMaxCount: 1 });
}

function tracePreflightError(error: unknown, rpcUrl: string, hash: string): Error {
  // Provider causes can embed credentials; retain the cause's redacted diagnostic at this boundary.
  return new Error(
    `real MPC callTracer preflight failed at ${new URL(rpcUrl).origin} for ${hash}: ${redactRpcDiagnostic(error, rpcUrl)}. Use a public HTTPS Sepolia endpoint that supports callTracer and a successful EVM_TRACE_PREFLIGHT_TX_HASH before funding or deployment.`,
    { cause: new Error(redactRpcDiagnostic(error, rpcUrl)) },
  );
}

/**
 * Verify the external singleton and actual mined-transaction tracing before setup spends funds.
 *
 * @param env - Explicit real configuration and a known successful EVM_TRACE_PREFLIGHT_TX_HASH.
 * @throws {Error} If configuration, deployed keys, Sepolia inclusion or callTracer output fails verification.
 */
export async function verifyRealInfrastructure(env: NodeJS.ProcessEnv): Promise<void> {
  configureRealMpc(env);
  const hash = env.EVM_TRACE_PREFLIGHT_TX_HASH ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/u.test(hash)) {
    throw new Error(
      "EVM_TRACE_PREFLIGHT_TX_HASH must explicitly name a mined Sepolia transaction (0x + 64 hex digits)",
    );
  }
  const node = getMidnightNodeConfig(env);
  const singleton = requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
  const indexer = indexerPublicDataProvider({
    queryURL: node.indexerUrl,
    subscriptionURL: node.indexerWsUrl,
  });
  try {
    const state = await indexer.queryContractState(singleton);
    if (state === null)
      throw new Error(`real MPC singleton ${singleton} is absent at ${node.indexerUrl}`);
    const manifest = parseZkArtifactManifest(
      await readFile(join(signetContractManagedPath, "compiler/contract-manifest.json"), "utf8"),
    );
    const paths = [...manifest.files.keys()].filter(
      (path) => path.startsWith("keys/") && path.endsWith(".verifier"),
    );
    if (paths.length !== 3 || state.operations().length !== paths.length) {
      throw new Error(
        "real MPC singleton must expose exactly the three published Signet operations",
      );
    }
    for (const relativePath of paths) {
      const expected = await readFile(join(signetContractManagedPath, relativePath));
      verifyZkArtifactIntegrity({ manifest, relativePath, bytes: expected, mode: "require" });
      const name = relativePath.slice("keys/".length, -".verifier".length);
      const operation = state.operation(name);
      if (operation === undefined || !expected.equals(operation.verifierKey)) {
        throw new Error(
          `real MPC singleton ${singleton} verifier key differs from the published SDK: ${name}`,
        );
      }
    }
    console.log(
      `real MPC singleton ${singleton} at ${node.indexerUrl}: all three published verifier keys match`,
    );
  } finally {
    await indexer.dispose();
  }

  const provider = boundedEvmProvider(env);
  try {
    if ((await provider.getNetwork()).chainId !== 11155111n)
      throw new Error("RPC chain is not Sepolia 11155111");
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash),
    ]);
    if (
      transaction === null ||
      receipt === null ||
      transaction.hash.toLowerCase() !== hash.toLowerCase() ||
      receipt.hash.toLowerCase() !== hash.toLowerCase() ||
      transaction.chainId !== 11155111n ||
      receipt.status !== 1 ||
      !Number.isSafeInteger(receipt.blockNumber) ||
      receipt.blockNumber < 0 ||
      !/^0x[0-9a-fA-F]{64}$/u.test(receipt.blockHash) ||
      transaction.blockHash !== receipt.blockHash ||
      transaction.blockNumber !== receipt.blockNumber
    ) {
      throw new Error("trace preflight transaction must have a successful matching mined receipt");
    }
    const block = await provider.getBlock(receipt.blockNumber);
    if (block?.hash !== receipt.blockHash)
      throw new Error("trace preflight receipt is not in the canonical block");
    const trace: unknown = await provider.send("debug_traceTransaction", [
      hash,
      { tracer: "callTracer", tracerConfig: { onlyTopCall: true } },
    ]);
    const output = parseCallTracerOutput(trace, transaction);
    console.log(
      `real MPC callTracer preflight: endpoint=${new URL(requireEnv(env, "EVM_RPC_URL")).origin} hash=${hash} block=${String(receipt.blockNumber)} blockHash=${receipt.blockHash} output=${output}`,
    );
  } catch (error) {
    throw tracePreflightError(error, requireEnv(env, "EVM_RPC_URL"), hash);
  } finally {
    provider.destroy();
  }
}

/**
 * Check gas and USDC only for requests that have not been reserved. Saved request
 * IDs must already be reconciled against the ledger: a reserved sweep can have
 * spent its funds, so checking its original balance would block settlement.
 *
 * @param env - Validated real configuration and the publicly derived EVM account addresses.
 * @throws {Error} If the token is not Sepolia USDC, balance reads fail or an account needs funding.
 */
export async function assertRealEvmFunding(env: NodeJS.ProcessEnv): Promise<void> {
  configureRealMpc(env);
  const user = requireEnv(env, "EVM_USER_ADDRESS");
  const vault = requireEnv(env, "EVM_VAULT_ADDRESS");
  const token = requireEnv(env, "ERC20_ADDRESS");
  if (token.toLowerCase() !== SEPOLIA_USDC.toLowerCase())
    throw new Error("ERC20_ADDRESS must be real Sepolia USDC");
  const provider = boundedEvmProvider(env);
  try {
    if ((await provider.getNetwork()).chainId !== 11155111n)
      throw new Error("funding preflight requires Sepolia 11155111");
    const accounts: string[] = [];
    if (!env.DEPOSIT_REQUEST_ID) accounts.push(user);
    if (!env.WITHDRAW_REQUEST_ID) accounts.push(vault);
    const [balances, usdc] = await Promise.all([
      Promise.all(
        accounts.map(async (account) => ({ account, balance: await provider.getBalance(account) })),
      ),
      env.DEPOSIT_REQUEST_ID
        ? undefined
        : getErc20Balance(requireEnv(env, "EVM_RPC_URL"), token, user),
    ]);
    const gasMinimum = parseEther("0.009");
    const deficits: string[] = [];
    for (const { account, balance } of balances) {
      if (balance < gasMinimum)
        deficits.push(
          `${account}: ETH deficit ${formatEther(gasMinimum - balance)} (balance ${formatEther(balance)}, minimum 0.009)`,
        );
    }
    if (usdc !== undefined) {
      const tokenMinimum = parseUnits("0.1", usdc.decimals);
      if (usdc.balance < tokenMinimum)
        deficits.push(
          `${user}: USDC ${token} deficit ${formatUnits(tokenMinimum - usdc.balance, usdc.decimals)} (balance ${formatUnits(usdc.balance, usdc.decimals)}, minimum 0.1)`,
        );
    }
    for (const deficit of deficits) console.log(`Sepolia funding needed: ${deficit}`);
    if (deficits.length > 0)
      throw new Error(
        "fund the listed public Sepolia accounts from a faucet, then resume this run",
      );
    console.log("Sepolia funding ready for the remaining unreserved happy-day requests");
  } finally {
    provider.destroy();
  }
}
