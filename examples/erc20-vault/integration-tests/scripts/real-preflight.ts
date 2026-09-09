import { buildBaseEnv } from "@sig-net/midnight-examples-lib";

import { verifyRealInfrastructure } from "../src/real-preflight.ts";

await verifyRealInfrastructure(buildBaseEnv());
