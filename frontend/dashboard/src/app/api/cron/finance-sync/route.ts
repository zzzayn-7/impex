import { NextRequest } from "next/server";

import { authorizeCron, runInternalJob } from "@/lib/cron";
import { financeServiceUrl } from "@/lib/finance";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One synchronisation pass of the Finance Service (pull Sales and Purchasing events, post what is due), on a schedule. See lib/cron.ts.
export async function POST(req: NextRequest) {
  return authorizeCron(req) ?? runInternalJob(financeServiceUrl(), "/internal/v1/finance/sync-cycle");
}
