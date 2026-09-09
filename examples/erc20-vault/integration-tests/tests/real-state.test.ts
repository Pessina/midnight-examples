import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireRealRunLock,
  loadRealState,
  realPrivateStorage,
  saveRealState,
} from "../src/real-state.ts";

const directories: string[] = [];

function stateEnv(): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "real-state-"));
  directories.push(directory);
  return { E2E_STATE_FILE: join(directory, "state.json") };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe("private real MPC checkpoints", () => {
  it.each([
    "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
    "DEPOSIT_REQUEST_ID",
    "WITHDRAW_REQUEST_ID",
    "REAL_DEPOSIT_SETTLED_TX_ID",
    "REAL_WITHDRAW_SETTLED_TX_ID",
  ])("requires producer-owned %s to originate in the saved journal", (key) => {
    const env = stateEnv();
    expect(() => loadRealState({ ...env, [key]: "ab".repeat(32) })).toThrow("saved journal");
    saveRealState(env, { [key]: "ab".repeat(32) });
    expect(loadRealState({ ...env, [key]: "ab".repeat(32) })[key]).toBe("ab".repeat(32));
  });
  it("holds an exclusive run lock until teardown", () => {
    const env = stateEnv();
    const release = acquireRealRunLock(env);
    expect(() => acquireRealRunLock(env)).toThrow("lock");
    release();
    const again = acquireRealRunLock(env);
    again();
  });

  it("keeps encrypted private state beside the private checkpoint", () => {
    const env = stateEnv();
    env.PRIVATE_STORAGE_PASSWORD = "synthetic-password";
    const storage = realPrivateStorage(env);
    expect(storage.databasePath).toBe(join(directories.at(-1) ?? "", "private-state"));
    expect(statSync(storage.databasePath).mode & 0o777).toBe(0o700);
    expect(storage.password).toBe("synthetic-password");
  });
  it("persists identities before use, excludes root seed and restores the same values", () => {
    const env = stateEnv();
    env.ROOT_SEED = "synthetic-root-never-persist";
    env.UNRELATED = "synthetic-unrelated-never-persist";
    saveRealState(env, {
      USER_SEED: "synthetic-user",
      MIDNIGHT_VAULT_CONTRACT_ADDRESS: "a".repeat(64),
    });
    const file = env.E2E_STATE_FILE ?? "";
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("synthetic-root");
    expect(readFileSync(file, "utf8")).not.toContain("synthetic-unrelated");
    expect(loadRealState({ E2E_STATE_FILE: file })).toMatchObject({
      USER_SEED: "synthetic-user",
      MIDNIGHT_VAULT_CONTRACT_ADDRESS: "a".repeat(64),
    });
  });

  it("refuses to change a reserved request identity", () => {
    const env = stateEnv();
    saveRealState(env, { DEPOSIT_REQUEST_ID: "a".repeat(64) });
    expect(() => {
      saveRealState(env, { DEPOSIT_REQUEST_ID: "b".repeat(64) });
    }).toThrow("DEPOSIT_REQUEST_ID");
    expect(loadRealState({ E2E_STATE_FILE: env.E2E_STATE_FILE }).DEPOSIT_REQUEST_ID).toBe(
      "a".repeat(64),
    );
  });

  it("rejects environment overrides conflicting with saved identities without disclosing values", () => {
    const env = stateEnv();
    saveRealState(env, { USER_SEED: "saved-secret" });
    expect(() => loadRealState({ ...env, USER_SEED: "replacement-secret" })).toThrow(
      "USER_SEED conflicts",
    );
    expect(() => loadRealState({ ...env, USER_SEED: "replacement-secret" })).not.toThrow(
      "saved-secret",
    );
  });

  it.each(["ROOT_SEED", "MPC_ROOT_KEY", "UNRELATED"])("rejects %s in saved state", (key) => {
    const env = stateEnv();
    writeFileSync(env.E2E_STATE_FILE ?? "", JSON.stringify({ [key]: "synthetic-secret" }), {
      mode: 0o600,
    });
    expect(() => loadRealState(env)).toThrow("unexpected checkpoint field");
  });

  it.each([0o644, 0o666])("rejects state file permission %i", (mode) => {
    const env = stateEnv();
    writeFileSync(env.E2E_STATE_FILE ?? "", "{}", { mode });
    expect(() => loadRealState(env)).toThrow("0600");
  });

  it("rejects a nonprivate directory", () => {
    const env = stateEnv();
    const directory = directories.at(-1) ?? "";
    chmodSync(directory, 0o755);
    expect(() => {
      saveRealState(env, {});
    }).toThrow("0700");
  });

  it("rejects symlink state files", () => {
    const env = stateEnv();
    const target = join(directories.at(-1) ?? "", "other.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, env.E2E_STATE_FILE ?? "");
    expect(() => loadRealState(env)).toThrow("regular file");
  });

  it("rejects a symlink parent", () => {
    stateEnv();
    const directory = directories.at(-1) ?? "";
    mkdirSync(join(directory, "private"), { mode: 0o700 });
    symlinkSync(join(directory, "private"), join(directory, "link"));
    expect(() => {
      saveRealState({ E2E_STATE_FILE: join(directory, "link", "state.json") }, {});
    }).toThrow("symlink");
  });

  it.each(["null", "[]", '{"USER_SEED":5}'])("rejects malformed state %s", (text) => {
    const env = stateEnv();
    writeFileSync(env.E2E_STATE_FILE ?? "", text, { mode: 0o600 });
    expect(() => loadRealState(env)).toThrow("checkpoint");
  });
});
