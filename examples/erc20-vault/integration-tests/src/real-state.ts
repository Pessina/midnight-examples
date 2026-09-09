import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { REPO_ROOT } from "@sig-net/midnight-examples-lib";

const STATE_KEYS: readonly string[] = [
  "NETWORK_ID",
  "MIDNIGHT_NODE_URL",
  "MIDNIGHT_NODE_INDEXER_URL",
  "MIDNIGHT_NODE_INDEXER_WS_URL",
  "MPC_SECP256K1_PUBKEY",
  "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  "EVM_CHAIN_ID",
  "ERC20_ADDRESS",
  "DEPLOYER_SEED",
  "USER_SEED",
  "VAULT_USER_SECRET_KEY",
  "VAULT_DEPLOYER_SECRET_KEY",
  "MAINTENANCE_SIGNING_KEY",
  "PRIVATE_STORAGE_PASSWORD",
  "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  "MPC_RESPONSE_KEY",
  "EVM_VAULT_ADDRESS",
  "EVM_USER_ADDRESS",
  "DEPOSIT_REQUEST_ID",
  "REAL_DEPOSIT_REQUEST_TX_ID",
  "REAL_DEPOSIT_UNSIGNED_TRANSACTION",
  "REAL_DEPOSIT_SIGNED_TRANSACTION",
  "REAL_DEPOSIT_KEY_VERSION",
  "REAL_DEPOSIT_PATH",
  "REAL_DEPOSIT_REQUESTER",
  "REAL_DEPOSIT_EXPECTED_SIGNER",
  "REAL_DEPOSIT_RESPOND_PROVENANCE",
  "WITHDRAW_REQUEST_ID",
  "REAL_DEPOSIT_SETTLED_TX_ID",
  "REAL_WITHDRAW_SETTLED_TX_ID",
  "REAL_ARTIFACT_DIGEST",
];

function statePath(env: NodeJS.ProcessEnv): string {
  const path = env.E2E_STATE_FILE;
  if (!path || !isAbsolute(path))
    throw new Error("E2E_STATE_FILE must be an absolute private scratch path");
  const directory = dirname(path);
  if (realpathSync(directory) !== directory)
    throw new Error("checkpoint directory must not use a symlink");
  const withinRepo = relative(realpathSync(REPO_ROOT), directory);
  if (withinRepo === "" || (!withinRepo.startsWith("..") && !isAbsolute(withinRepo))) {
    throw new Error("checkpoint must be outside the repository in private scratch");
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== userInfo().uid) {
    throw new Error("checkpoint directory must be owned by this user with mode 0700");
  }
  if (lstatSync(path, { throwIfNoEntry: false })) {
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1)
      throw new Error("checkpoint must be a regular file without links");
    if ((file.mode & 0o777) !== 0o600 || file.uid !== userInfo().uid) {
      throw new Error("checkpoint file must be owned by this user with mode 0600");
    }
  }
  return path;
}

function readState(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid checkpoint object");
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!STATE_KEYS.includes(key)) throw new Error(`unexpected checkpoint field ${key}`);
    if (typeof value !== "string" || value === "")
      throw new Error(`invalid checkpoint field ${key}`);
    entries[key] = value;
  }
  return entries;
}

function assertConsistent(saved: Record<string, string>, entries: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(saved)) {
    if (entries[key] && entries[key] !== value)
      throw new Error(`${key} conflicts with the private checkpoint`);
  }
}

/**
 * Restore a real run without replacing saved identities or request reservations.
 * ROOT_SEED is supplied separately and is never part of this checkpoint.
 *
 * @param env - Explicit real configuration and private checkpoint path.
 * @returns The restored environment, without mutating the input.
 * @throws {Error} If file ownership, permissions, fields or explicit values conflict.
 */
export function loadRealState(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const saved = readState(statePath(env));
  for (const key of [
    "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
    "DEPOSIT_REQUEST_ID",
    "WITHDRAW_REQUEST_ID",
    "REAL_DEPOSIT_SETTLED_TX_ID",
    "REAL_WITHDRAW_SETTLED_TX_ID",
  ]) {
    if (env[key] && !saved[key]) {
      throw new Error(
        `${key} must originate in the saved journal; do not supply unsaved resume facts`,
      );
    }
  }
  assertConsistent(saved, env);
  return { ...env, ...saved };
}

/**
 * Durably reserve new run facts before submission. Saved facts are immutable;
 * an interrupted submission must be reconciled on chain, never replaced on retry.
 *
 * @param env - Run environment, updated only after the checkpoint is durable.
 * @param entries - New identities or transaction facts to reserve.
 * @throws {Error} If storage is unsafe or a saved fact would change.
 */
export function saveRealState(env: NodeJS.ProcessEnv, entries: Record<string, string> = {}): void {
  const path = statePath(env);
  for (const key of Object.keys(entries)) {
    if (!STATE_KEYS.includes(key)) throw new Error(`unexpected checkpoint field ${key}`);
  }
  const saved = readState(path);
  assertConsistent(saved, env);
  assertConsistent(saved, entries);
  const next = { ...saved };
  for (const key of STATE_KEYS) {
    const value = entries[key] ?? env[key];
    if (value) next[key] = value;
  }
  const temporary = join(dirname(path), `.checkpoint-${randomUUID()}`);
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    try {
      writeFileSync(descriptor, JSON.stringify(next, null, 2));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  Object.assign(env, entries);
}

/**
 * Hold an exclusive checkpoint lock for the complete setup and worker lifetime.
 *
 * @param env - Private checkpoint configuration.
 * @returns The teardown that releases this run's lock.
 * @throws {Error} If a previous run holds the lock; an interrupted owner requires inspection.
 */
export function acquireRealRunLock(env: NodeJS.ProcessEnv): () => void {
  const path = `${statePath(env)}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch {
    throw new Error(
      `real run lock exists at ${path}; inspect its owner and reconcile the interrupted run before removing it`,
    );
  }
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
  return () => {
    unlinkSync(path);
  };
}

/**
 * Resolve isolated encrypted storage beneath the private checkpoint directory.
 *
 * @param env - Private checkpoint and secret storage password.
 * @returns Provider storage configuration.
 * @throws {Error} If the directory is unsafe or the password is missing.
 */
export function realPrivateStorage(env: NodeJS.ProcessEnv): {
  databasePath: string;
  password: string;
} {
  const databasePath = join(dirname(statePath(env)), "private-state");
  const password = env.PRIVATE_STORAGE_PASSWORD;
  if (!password) throw new Error("PRIVATE_STORAGE_PASSWORD is required for real private state");
  mkdirSync(databasePath, { mode: 0o700, recursive: true });
  const stat = lstatSync(databasePath);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== userInfo().uid
  ) {
    throw new Error(
      "private state directory must be owned by this user with mode 0700 and no symlink",
    );
  }
  return { databasePath, password };
}
