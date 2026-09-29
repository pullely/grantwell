import type { Env } from "./env.js";
import { route } from "./router.js";
import { runReminders } from "./reminders.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /** The reminder ladder: once a day at 13:00 UTC (wrangler `triggers.crons`). */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runReminders(env, new Date(controller.scheduledTime)).then((r) => {
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
