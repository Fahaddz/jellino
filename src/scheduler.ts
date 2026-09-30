import type { DurableObjectState, ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "./db";
import { serverSecret } from "./session";

export const SCHEDULER_OBJECT_NAME = "scheduler";
export const SCHEDULE_INTERVAL_MS = 15 * 60 * 1000;
export const SCHEDULER_ENSURE_URL = "https://jellino.internal/scheduler/ensure";
export const SCHEDULER_RUN_PATH = "/__internal/scheduled";
export const SCHEDULER_RUN_URL = `https://jellino.internal${SCHEDULER_RUN_PATH}`;

interface AlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

async function armAlarm(storage: AlarmStorage, now: number): Promise<void> {
  const current = await storage.getAlarm();
  if (current !== null && current > now) return;
  await storage.setAlarm(now + SCHEDULE_INTERVAL_MS);
}

async function triggerScheduledRun(env: Env): Promise<void> {
  if (!env.SELF) throw new Error("SELF service binding missing");
  const secret = await serverSecret(env.DB);
  const response = await env.SELF.fetch(SCHEDULER_RUN_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!response.ok) throw new Error(`scheduled run answered ${response.status}`);
}

export class SchedulerDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/scheduler/ensure") return new Response("Not Found", { status: 404 });
    await armAlarm(this.state.storage, Date.now());
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + SCHEDULE_INTERVAL_MS);
    try {
      await triggerScheduledRun(this.env);
    } catch (error) {
      console.error(`scheduled run failed: ${String(error)}`);
    }
  }
}

let schedulerEnsured = false;

export function ensureScheduledRun(env: Env, ctx: ExecutionContext): void {
  if (schedulerEnsured || !env.SCHEDULER) return;
  schedulerEnsured = true;
  const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName(SCHEDULER_OBJECT_NAME));
  ctx.waitUntil(
    stub
      .fetch(SCHEDULER_ENSURE_URL)
      .then(() => undefined)
      .catch(() => {
        schedulerEnsured = false;
      }),
  );
}
