import { env } from "./config/env.js";

export function log(event: string, data: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: env.LOG_LEVEL,
      event,
      ...data,
      timestamp: new Date().toISOString()
    })
  );
}

