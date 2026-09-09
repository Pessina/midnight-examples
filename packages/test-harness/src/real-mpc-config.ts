import { isIP } from "node:net";

import { GENESIS_MINT_WALLET_SEED, getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";
import { decodeBase58, SigningKey } from "ethers";

import { MpcMode, resolveMpcMode } from "./mpc-mode.ts";

/**
 * Validate a public secp256k1 point and return compressed SEC1 hex.
 *
 * @param value - Compressed/uncompressed SEC1 hex or secp256k1-prefixed base58 X/Y bytes.
 * @returns The canonical compressed public key.
 * @throws {Error} If the value is not a valid public point, including a private key.
 */
export function normalizeMpcPublicKey(value: string): string {
  let hex = value.trim().replace(/^0x/iu, "");
  if (hex.startsWith("secp256k1:")) {
    const encoded = hex.slice("secp256k1:".length);
    const decoded = decodeBase58(encoded);
    const digits = decoded.toString(16);
    const leadingZeroes = /^1*/u.exec(encoded)?.[0].length ?? 0;
    const byteLength = leadingZeroes + (decoded === 0n ? 0 : Math.ceil(digits.length / 2));
    if (byteLength !== 64) throw new Error("MPC public key must encode 64 X/Y bytes");
    hex = `04${digits.padStart(128, "0")}`;
  }
  if (!/^(?:0[23][0-9a-f]{64}|04[0-9a-f]{128})$/iu.test(hex)) {
    throw new Error("MPC public key must be a SEC1 public point, never a private key");
  }
  return SigningKey.computePublicKey(`0x${hex}`, true).toLowerCase();
}

const TESTNET_DEV_PUBLIC_KEY =
  "0x02cb41bab8bc97121f4902514ca57a284f167b9239ecb8176831d1ef0fede87c61";

/**
 * Check the explicit real MPC public key against Signet TESTNET_DEV.
 *
 * @param env - Configuration carrying MPC_SECP256K1_PUBKEY.
 * @returns The canonical TESTNET_DEV public key.
 * @throws {Error} If the public key is absent, malformed or belongs to another network.
 */
export function realMpcPublicKey(env: NodeJS.ProcessEnv): string {
  if (env.MPC_ROOT_KEY?.trim()) throw new Error("MPC_ROOT_KEY is incompatible with real MPC mode");
  try {
    const key = normalizeMpcPublicKey(env.MPC_SECP256K1_PUBKEY ?? "");
    if (key === TESTNET_DEV_PUBLIC_KEY) return key;
  } catch {
    // Never attach the input or ethers' diagnostic: either may contain a supplied secret.
  }
  throw new Error("MPC_SECP256K1_PUBKEY must be the explicit Signet TESTNET_DEV public key");
}

/**
 * Validate the complete public-network boundary before committing canonical configuration.
 *
 * @param env - Explicit real-mode configuration, canonicalized only after every check passes.
 * @throws {Error} If any key, endpoint, chain, singleton or fakenet setting conflicts.
 */
export function configureRealMpc(env: NodeJS.ProcessEnv): void {
  if (resolveMpcMode(env) !== MpcMode.Real) throw new Error("MPC_MODE must explicitly be real");
  for (const [key, value] of Object.entries(env)) {
    if (!value?.trim() || (key === "FAKENET_MANAGED" && value === "0")) continue;
    if (
      key.endsWith("_SEED") &&
      value.trim().replace(/^0x/iu, "").toLowerCase() === GENESIS_MINT_WALLET_SEED
    ) {
      throw new Error(`${key} must not use the public local genesis mint wallet seed in real mode`);
    }
    if (
      /^(?:FAKENET_|SEPOLIA_FORK_|FORK_|ANVIL_)/u.test(key) ||
      [
        "MPC_ROOT_KEY",
        "MPC_RESPONDER_SEED",
        "MIDNIGHT_NETWORK_ID",
        "MIDNIGHT_INDEXER_URL",
        "MIDNIGHT_INDEXER_WS_URL",
        "MIDNIGHT_PROOF_SERVER_URL",
        "RESPONSES_API_PORT",
      ].includes(key)
    ) {
      throw new Error(`${key} is incompatible with real MPC mode`);
    }
  }
  const publicKey = realMpcPublicKey(env);
  const expected: Readonly<Record<string, string>> = {
    NETWORK_ID: "stagenet",
    EVM_CHAIN_ID: "11155111",
    MIDNIGHT_SIGNET_CONTRACT_ADDRESS:
      "777c5ab3f79c7227e4eccab115bb5f26f31948de7992b0f2a973dd52e1b6be0f",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) throw new Error(`${key} must explicitly match the real MPC network`);
  }
  const node = getMidnightNodeConfig(env);
  const endpoints: readonly [string, string, string][] = [
    ["MIDNIGHT_NODE_URL", node.nodeUrl, "https://rpc.stagenet.shielded.tools/"],
    [
      "MIDNIGHT_NODE_INDEXER_URL",
      node.indexerUrl,
      "https://indexer.stagenet.shielded.tools/api/v4/graphql",
    ],
    [
      "MIDNIGHT_NODE_INDEXER_WS_URL",
      node.indexerWsUrl,
      "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
    ],
  ];
  for (const [key, actual, allowed] of endpoints) {
    if (parseEndpoint(actual, key).href !== allowed)
      throw new Error(`${key} must use Stagenet shielded.tools`);
  }
  const proof = parseEndpoint(node.proofServerUrl, "MIDNIGHT_NODE_PROOF_SERVER_URL");
  if (proof.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(proof.hostname)) {
    throw new Error("MIDNIGHT_NODE_PROOF_SERVER_URL must use loopback HTTP");
  }
  const rpc = parseEndpoint(env.EVM_RPC_URL ?? "", "EVM_RPC_URL");
  const hostname = rpc.hostname.replace(/\.$/u, "");
  if (
    rpc.protocol !== "https:" ||
    isIP(hostname.replace(/^\[|\]$/gu, "")) !== 0 ||
    !hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|test|invalid|example|onion|alt|arpa)$/u.test(
      hostname,
    )
  ) {
    throw new Error(
      "EVM_RPC_URL must use a public HTTPS hostname, not an IP literal or local/reserved name",
    );
  }
  env.MPC_SECP256K1_PUBKEY = publicKey;
}

function parseEndpoint(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid endpoint URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must not contain credentials, query parameters or fragments`);
  }
  return url;
}
