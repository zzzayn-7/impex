import { NextRequest } from "next/server";

import { authorizeCron, runInternalJob } from "@/lib/cron";
import { supportServiceUrl } from "@/lib/support";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One pass of the Support Service's e-mail outbox (send what is due), on a schedule. See lib/cron.ts.
export async function POST(req: NextRequest) {
  return authorizeCron(req) ?? runInternalJob(supportServiceUrl(), "/internal/v1/support/outbox-run");
}
