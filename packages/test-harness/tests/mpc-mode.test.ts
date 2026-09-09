import { deriveMidnightResponseKey, formatSecp256k1PublicKey } from "@sig-net/midnight";
import { GENESIS_MINT_WALLET_SEED } from "@sig-net/midnight-contract-deploy";
import { SigningKey } from "ethers";
import { describe, expect, it, vi } from "vitest";

import { assertFakenetMode, MpcMode, resolveMpcMode } from "../src/mpc-mode.ts";
import { configureRealMpc, normalizeMpcPublicKey } from "../src/real-mpc-config.ts";
import {
  deploySignetContractStep,
  ensureMpcResponseKey,
  ensureMpcRootKey,
  ensureMpcSecp256k1Pubkey,
  persistFakenetHandoffToDotEnv,
  printMpcServerConfig,
  startFakenetResponder,
} from "../src/steps.ts";

const PUBLIC_KEY = "0x02cb41bab8bc97121f4902514ca57a284f167b9239ecb8176831d1ef0fede87c61";
const BASE58_KEY =
  "secp256k1:54hU5wcCmVUPFWLDALXMh1fFToZsVXrx9BbTbHzSfQq1Kd1rJZi52iPa4QQxo6s5TgjWqgpY8HamYuUDzG6fAaUq";
const VALID_ENV: NodeJS.ProcessEnv = {
  MPC_MODE: "real",
  MPC_SECP256K1_PUBKEY: BASE58_KEY,
  NETWORK_ID: "stagenet",
  MIDNIGHT_SIGNET_CONTRACT_ADDRESS:
    "777c5ab3f79c7227e4eccab115bb5f26f31948de7992b0f2a973dd52e1b6be0f",
  EVM_CHAIN_ID: "11155111",
  EVM_RPC_URL: "https://ethereum-sepolia-rpc.publicnode.com",
};

describe("MPC mode boundary", () => {
  it.each([undefined, "", "fakenet"])("defaults %j to fakenet", (mode) => {
    expect(resolveMpcMode({ MPC_MODE: mode, FAKENET_MANAGED: "0" })).toBe(MpcMode.Fakenet);
  });

  it("requires an explicit valid mode", () => {
    expect(resolveMpcMode({ MPC_MODE: "real" })).toBe(MpcMode.Real);
    expect(() => resolveMpcMode({ MPC_MODE: "typo" })).toThrow("MPC_MODE");
    expect(() => {
      assertFakenetMode({ MPC_MODE: "real" }, "operation");
    }).toThrow("operation");
    expect(() => {
      assertFakenetMode({}, "operation");
    }).not.toThrow();
  });

  it.each([
    BASE58_KEY,
    PUBLIC_KEY,
    PUBLIC_KEY.slice(2).toUpperCase(),
    SigningKey.computePublicKey(PUBLIC_KEY),
  ])("canonicalizes public input %s", (key) => {
    expect(normalizeMpcPublicKey(key)).toBe(PUBLIC_KEY);
  });

  it.each([
    "0x" + "01".repeat(32),
    "0x02" + "ff".repeat(32),
    "0x04" + "00".repeat(64),
    "secp256k1:1",
    "secp256k1:0",
    "garbage",
  ])("rejects malformed, off-curve or private input %s", (key) => {
    expect(() => normalizeMpcPublicKey(key)).toThrow();
  });

  it("accepts the public configuration and canonicalizes without a root private key", () => {
    const env: NodeJS.ProcessEnv = { ...VALID_ENV, FAKENET_MANAGED: "0" };
    configureRealMpc(env);
    expect(env.MPC_SECP256K1_PUBKEY).toBe(PUBLIC_KEY);
    expect(env).not.toHaveProperty("MPC_ROOT_KEY");
  });

  it("accepts an alternate public HTTPS hostname for live Sepolia and trace preflight", () => {
    expect(() => {
      configureRealMpc({ ...VALID_ENV, EVM_RPC_URL: "https://sepolia.example.org" });
    }).not.toThrow();
  });

  const REJECTED: readonly [string, string][] = [
    ["MPC_SECP256K1_PUBKEY", ""],
    [
      "MPC_SECP256K1_PUBKEY",
      "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    ],
    ["MIDNIGHT_SIGNET_CONTRACT_ADDRESS", "00".repeat(32)],
    ["NETWORK_ID", "undeployed"],
    ["EVM_CHAIN_ID", "31337"],
    ["EVM_CHAIN_ID", ""],
    ["EVM_RPC_URL", "http://ethereum-sepolia-rpc.publicnode.com"],
    ["EVM_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com.attacker.test"],
    ["EVM_RPC_URL", "https://user:secret@ethereum-sepolia-rpc.publicnode.com"],
    ["EVM_RPC_URL", "https://localhost"],
    ["EVM_RPC_URL", "https://127.0.0.1"],
    ["EVM_RPC_URL", "https://127.1"],
    ["EVM_RPC_URL", "https://10.0.0.1"],
    ["EVM_RPC_URL", "https://192.168.1.1"],
    ["EVM_RPC_URL", "https://8.8.8.8"],
    ["EVM_RPC_URL", "https://[::1]"],
    ["EVM_RPC_URL", "https://rpc.local"],
    ["EVM_RPC_URL", "https://rpc.localhost."],
    ["EVM_RPC_URL", "https://rpc.internal"],
    ["EVM_RPC_URL", "https://node"],
    ["EVM_RPC_URL", "https://sepolia.example.org?secret=value"],
    ["EVM_RPC_URL", "https://sepolia.example.org#fragment"],
    ["MIDNIGHT_NODE_URL", "http://localhost:9944"],
    ["MIDNIGHT_NODE_INDEXER_URL", "https://other.test/graphql"],
    ["MIDNIGHT_NODE_INDEXER_WS_URL", "ws://localhost:8080"],
    ["MIDNIGHT_NODE_PROOF_SERVER_URL", "https://proof.example"],
    ["MIDNIGHT_NODE_PROOF_SERVER_URL", "http://127.0.0.1.attacker.test"],
    ["MPC_ROOT_KEY", "secret-marker"],
    ["MPC_RESPONDER_SEED", "secret-marker"],
    ["FAKENET_MANAGED", "1"],
    ["FAKENET_RESPONSES_URL", "http://localhost:3040"],
    ["SEPOLIA_FORK_RPC_URL", "https://fork.example"],
    ["SEPOLIA_FORK_BLOCK", "100"],
    ["MIDNIGHT_NETWORK_ID", "stagenet"],
    ["ROOT_SEED", GENESIS_MINT_WALLET_SEED],
    ["DEPLOYER_SEED", `0x${GENESIS_MINT_WALLET_SEED}`],
    ["USER_SEED", `  0X${GENESIS_MINT_WALLET_SEED}  `],
  ];

  it.each(REJECTED)("rejects incompatible %s without changing configuration", (key, value) => {
    const env = { ...VALID_ENV, [key]: value };
    const before = { ...env };
    expect(() => {
      configureRealMpc(env);
    }).toThrow(key);
    expect(env).toEqual(before);
  });

  it.each(["http://localhost:6300", "http://127.0.0.1:6300", "http://[::1]:6300"])(
    "accepts loopback proof endpoint %s",
    (url) => {
      expect(() => {
        configureRealMpc({ ...VALID_ENV, MIDNIGHT_NODE_PROOF_SERVER_URL: url });
      }).not.toThrow();
    },
  );

  const GUARDED: readonly [string, (env: NodeJS.ProcessEnv) => void | Promise<void>][] = [
    ["root generation", ensureMpcRootKey],
    ["singleton deployment", deploySignetContractStep],
    ["dotenv handoff", persistFakenetHandoffToDotEnv],
    ["responder startup", startFakenetResponder],
    [
      "fakenet printout",
      (env) => {
        printMpcServerConfig(env, []);
      },
    ],
  ];

  it.each(GUARDED)("blocks %s before effects", async (_name, action) => {
    const log = vi.spyOn(console, "log").mockImplementation(vi.fn());
    try {
      const env = { ...VALID_ENV, FAKENET_MANAGED: "0" };
      await expect(Promise.resolve().then(() => action(env))).rejects.toThrow("fakenet");
      expect(env).toEqual({ ...VALID_ENV, FAKENET_MANAGED: "0" });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("derives the response key using only public inputs and accepts equivalent encodings", () => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_ENV,
      MIDNIGHT_VAULT_CONTRACT_ADDRESS: "ab".repeat(32),
    };
    ensureMpcSecp256k1Pubkey(env);
    const expected = formatSecp256k1PublicKey(
      deriveMidnightResponseKey(PUBLIC_KEY, "ab".repeat(32)),
    );
    env.MPC_RESPONSE_KEY = SigningKey.computePublicKey(expected).toUpperCase();
    ensureMpcResponseKey(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
    expect(env.MPC_RESPONSE_KEY).toBe(expected);
    expect(env.MPC_SECP256K1_PUBKEY).toBe(PUBLIC_KEY);
    expect(env.MPC_ROOT_KEY).toBeUndefined();
  });

  it("rejects a root private key when the real public-key step is invoked directly", () => {
    expect(() => {
      ensureMpcSecp256k1Pubkey({ ...VALID_ENV, MPC_ROOT_KEY: "secret-marker" });
    }).toThrow("MPC_ROOT_KEY");
  });

  it("preserves fakenet public derivation and rejects mismatching response keys", () => {
    const env: NodeJS.ProcessEnv = {
      MPC_ROOT_KEY: "01".repeat(32),
      MIDNIGHT_VAULT_CONTRACT_ADDRESS: "ab".repeat(32),
    };
    ensureMpcSecp256k1Pubkey(env);
    expect(env.MPC_SECP256K1_PUBKEY).toBe(
      new SigningKey(`0x${"01".repeat(32)}`).compressedPublicKey,
    );
    env.MPC_RESPONSE_KEY = PUBLIC_KEY;
    expect(() => {
      ensureMpcResponseKey(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
    }).toThrow("public key");
  });
});
