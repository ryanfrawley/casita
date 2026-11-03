// core/scheduler.ts
// every / after / cron, each tied to an AbortSignal so unloading cancels its timers.

import { Cron } from "croner";
import { CoreError } from "./errors.ts";
import type { Logger, Scheduler } from "./types.ts";
import { errorMessage } from "./util.ts";

/** The IANA zone the scheduler will use; throws on a name the runtime does not know. */
export function resolveTimezone(name?: string): string {
  if (!name) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return Intl.DateTimeFormat(undefined, { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    throw new CoreError("invalid", `Unknown time zone "${name}"`);
  }
}

export function createScheduler(signal: AbortSignal, timezone: string, log: Logger): Scheduler {
  const cancels = new Set<() => void>();
  signal.addEventListener(
    "abort",
    () => {
      for (const cancel of [...cancels]) cancel();
    },
    { once: true },
  );

  const guarded = (fn: () => void | Promise<void>) => async () => {
    if (signal.aborted) return;
    try {
      await fn();
    } catch (err) {
      log.error("scheduled task failed", { error: errorMessage(err) });
    }
  };

  const track = (stop: () => void) => {
    if (signal.aborted) {
      stop();
      return () => {};
    }
    const cancel = () => {
      stop();
      cancels.delete(cancel);
    };
    cancels.add(cancel);
    return cancel;
  };

  return {
    every(ms, fn) {
      const run = guarded(fn);
      let timer: ReturnType<typeof setTimeout>;
      const tick = () => {
        timer = setTimeout(tick, ms);
        void run();
      };
      timer = setTimeout(tick, ms);
      return track(() => clearTimeout(timer));
    },
    after(ms, fn) {
      const run = guarded(fn);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = track(() => clearTimeout(timer));
      if (signal.aborted) return cancel;
      timer = setTimeout(() => {
        cancel();
        void run();
      }, ms);
      return cancel;
    },
    cron(expr, fn) {
      const job = new Cron(expr, { timezone }, guarded(fn));
      return track(() => job.stop());
    },
  };
}
