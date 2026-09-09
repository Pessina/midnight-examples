/** Which MPC infrastructure supplies signatures and execution attestations. */
export enum MpcMode {
  Fakenet = "fakenet",
  Real = "real",
}

/**
 * Resolve the explicit mode, preserving the local fakenet default.
 *
 * @param env - Configuration containing MPC_MODE.
 * @returns The selected mode.
 * @throws {Error} If MPC_MODE is not a supported mode.
 */
export function resolveMpcMode(env: NodeJS.ProcessEnv): MpcMode {
  const value = env.MPC_MODE?.trim();
  if (!value) return MpcMode.Fakenet;
  const mode = Object.values(MpcMode).find((candidate: string) => candidate === value);
  if (mode !== undefined) return mode;
  throw new Error("MPC_MODE must be fakenet or real");
}

/**
 * Reject a fakenet operation before it can access keys, files or services.
 *
 * @param env - Configuration containing MPC_MODE.
 * @param operation - Public operation name, without secret values.
 * @throws {Error} If the operation is attempted outside fakenet mode.
 */
export function assertFakenetMode(env: NodeJS.ProcessEnv, operation: string): void {
  if (resolveMpcMode(env) !== MpcMode.Fakenet) {
    throw new Error(`${operation} requires fakenet mode`);
  }
}
