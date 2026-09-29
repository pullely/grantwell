import type { Env } from "./env.js";
import { route } from "./router.js";
import { runReminders } from "./reminders.js";
import { runDigest } from "./portfolio.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /**
   * Once a day at 13:00 UTC (wrangler `triggers.crons`): the reminder ladder;
   * on Mondays also the grant writer's weekly digest (GW3).
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    if (now.getUTCDay() === 1) {
      ctx.waitUntil(
        runDigest(env, now).then((r) => {
          // eslint-disable-next-line no-console -- one structured line per weekly run
          console.log(JSON.stringify({ level: "info", msg: "grant digest run", ...r }));
        }),
      );
    }
    ctx.waitUntil(
      runReminders(env, now).then((r) => {
        // eslint-disable-next-line no-console -- one structured line per daily run
        console.log(
          JSON.stringify({
            level: "info",
            msg: "grant reminders run",
            today: r.today,
            considered: r.considered,
            claimed: r.claimed.length,
            skippedNoRecipient: r.skippedNoRecipient,
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>;
