import {
  bytesToHex,
  deriveEvmAddress,
  type RequestIdHex,
  type SignetRequestResponseReader,
} from "@sig-net/midnight";
import { MpcMode, requireEnv, resolveMpcMode } from "@sig-net/midnight-examples-test-harness";
import { FetchRequest, JsonRpcProvider, type Transaction } from "ethers";

import { fetchFakenetResponse } from "./fakenet-responses.ts";
import { warnOnce } from "./warn-once.ts";

/** An untrusted execution-output source; only attestation verification authenticates its bytes. */
export type EvmOutputProvider = (
  reader: SignetRequestResponseReader,
  requestId: RequestIdHex,
) => Promise<string | undefined>;

const TICK_TIMEOUT_MS = 3_000;

/**
 * Remove authenticated RPC URL paths from a diagnostic before it leaves the process.
 *
 * @param error - The provider's untrusted diagnostic.
 * @param rpcUrl - The configured endpoint whose path can contain credentials.
 * @returns Diagnostic text retaining the public origin without endpoint path credentials.
 */
export function redactRpcDiagnostic(error: unknown, rpcUrl: string): string {
  const endpoint: URL = new URL(rpcUrl);
  let diagnostic: string = String(error).replaceAll(rpcUrl, endpoint.origin);
  for (const segment of endpoint.pathname.split("/")) {
    if (segment.length > 0) diagnostic = diagnostic.replaceAll(segment, "[redacted]");
  }
  return diagnostic;
}

/**
 * Validate a callTracer root against the signed transaction whose execution was requested.
 *
 * @param trace - Untrusted JSON-RPC result, including malformed or alternative tracer responses.
 * @param transaction - The SDK-reconstructed signed transaction, or the mined transaction in preflight.
 * @returns Nonempty, byte-aligned top-level output hex; nested calls are never searched.
 * @throws {Error} If the trace does not describe this successful root call or has no output bytes.
 */
export function parseCallTracerOutput(
  trace: unknown,
  transaction: Pick<Transaction, "from" | "to" | "data">,
): string {
  if (
    typeof trace !== "object" ||
    trace === null ||
    Array.isArray(trace) ||
    !("type" in trace) ||
    trace.type !== "CALL" ||
    "error" in trace ||
    !("from" in trace) ||
    typeof trace.from !== "string" ||
    !("to" in trace) ||
    typeof trace.to !== "string" ||
    !("input" in trace) ||
    typeof trace.input !== "string" ||
    trace.from.toLowerCase() !== transaction.from?.toLowerCase() ||
    trace.to.toLowerCase() !== transaction.to?.toLowerCase() ||
    trace.input.toLowerCase() !== transaction.data.toLowerCase() ||
    !("output" in trace) ||
    typeof trace.output !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(trace.output)
  ) {
    throw new Error(
      "callTracer result is not the successful root call with nonempty output for this transaction",
    );
  }
  return trace.output;
}

/**
 * Observe only the mined transaction reconstructed from an SDK-verified MPC signature.
 *
 * @param rpcUrl - Validated Sepolia public RPC URL.
 * @param mpcPublicKey - Validated root public key; no private key is accepted.
 * @param vaultContractAddress - Validated requesting vault address.
 * @returns A bounded output source that releases its RPC provider after every poll tick.
 */
export function createRealEvmOutputProvider(
  rpcUrl: string,
  mpcPublicKey: string,
  vaultContractAddress: string,
): EvmOutputProvider {
  return async (reader, requestId) => {
    const connection = new FetchRequest(rpcUrl);
    connection.timeout = TICK_TIMEOUT_MS;
    const provider = new JsonRpcProvider(connection, undefined, { batchMaxCount: 1 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observe = async (): Promise<string | undefined> => {
        const request = await reader.getSignatureRequest(requestId);
        if (
          bytesToHex(request.sender.bytes) !==
          vaultContractAddress.replace(/^0x/i, "").toLowerCase()
        ) {
          throw new Error("request sender does not match the configured vault");
        }
        const expectedSigner = deriveEvmAddress(
          mpcPublicKey,
          vaultContractAddress,
          bytesToHex(request.path),
        );
        const transaction = await reader.getSignedEvmTransaction(requestId, expectedSigner);
        if (transaction === undefined) return undefined;
        if (
          transaction.chainId !== 11155111n ||
          (await provider.getNetwork()).chainId !== 11155111n
        ) {
          throw new Error("execution output requires Sepolia chain 11155111");
        }
        const hash = transaction.hash;
        if (hash === null) throw new Error("SDK transaction is unsigned");
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt === null) return undefined;
        if (
          receipt.hash !== hash ||
          receipt.status !== 1 ||
          !Number.isSafeInteger(receipt.blockNumber) ||
          receipt.blockNumber < 0 ||
          !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)
        ) {
          throw new Error("receipt is not a successful mined execution of the signed transaction");
        }
        const block = await provider.getBlock(receipt.blockNumber);
        if (block?.hash !== receipt.blockHash)
          throw new Error("execution receipt is not in the canonical block");
        const trace: unknown = await provider.send("debug_traceTransaction", [
          hash,
          { tracer: "callTracer", tracerConfig: { onlyTopCall: true } },
        ]);
        return parseCallTracerOutput(trace, transaction);
      };
      return await Promise.race([
        observe(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("execution output poll tick timed out"));
          }, TICK_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      warnOnce(
        `trace:${requestId}`,
        `execution output unavailable for ${requestId}: ${redactRpcDiagnostic(error, rpcUrl)}`,
      );
      return undefined;
    } finally {
      clearTimeout(timer);
      provider.destroy();
    }
  };
}

/**
 * Select the output source from the explicit setup environment.
 *
 * @param env - The validated setup configuration; no process-global mode is read.
 * @returns The real mined-output source or the default fakenet cache source.
 * @throws {Error} If required real configuration is absent or the mode is invalid.
 */
export function createEvmOutputProvider(env: NodeJS.ProcessEnv): EvmOutputProvider {
  if (resolveMpcMode(env) === MpcMode.Real) {
    return createRealEvmOutputProvider(
      requireEnv(env, "EVM_RPC_URL"),
      requireEnv(env, "MPC_SECP256K1_PUBKEY"),
      requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    );
  }
  return async (_reader, requestId) => {
    const cached = await fetchFakenetResponse(requestId, TICK_TIMEOUT_MS, env);
    return cached.success && cached.output !== null ? cached.output : undefined;
  };
}
