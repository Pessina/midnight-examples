/** The explicit live operations enabled for a deployed-MPC integration run. */
export enum RealMpcStage {
  /** Submit a Midnight request and verify its finalized MPC signature. */
  SigningOnly = "signing-only",
  /** Broadcast on EVM, verify RespondBidirectional and settle on Midnight. */
  Bidirectional = "bidirectional",
}

/**
 * Require the operator to select the deployed-MPC run's live scope.
 *
 * @param env - The real integration run's configuration.
 * @returns The explicitly selected stage.
 * @throws {Error} If REAL_MPC_STAGE is absent or unsupported.
 */
export function resolveRealMpcStage(env: NodeJS.ProcessEnv): RealMpcStage {
  const stage: string | undefined = env.REAL_MPC_STAGE;
  if (stage === RealMpcStage.SigningOnly) return RealMpcStage.SigningOnly;
  if (stage === RealMpcStage.Bidirectional) return RealMpcStage.Bidirectional;
  throw new Error("REAL_MPC_STAGE must be signing-only or bidirectional");
}
