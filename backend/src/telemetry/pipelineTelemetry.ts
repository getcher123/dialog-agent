import { randomUUID } from "node:crypto";

import { log } from "../logging.js";

export interface StageMetric {
  name: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export class PipelineTrace {
  readonly traceId: string;
  readonly sessionId: string;
  readonly route: string;
  readonly startedAt: number;
  private readonly stages: StageMetric[] = [];

  constructor(sessionId: string, route: string) {
    this.traceId = randomUUID();
    this.sessionId = sessionId;
    this.route = route;
    this.startedAt = Date.now();

    log("pipeline.trace.started", {
      traceId: this.traceId,
      sessionId: this.sessionId,
      route: this.route
    });
  }

  completeStage(
    name: string,
    startedAt: number,
    completedAt: number,
    metadata?: Record<string, unknown>
  ): StageMetric {
    const stage: StageMetric = {
      name,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      metadata
    };

    this.stages.push(stage);

    log("pipeline.stage.completed", {
      traceId: this.traceId,
      sessionId: this.sessionId,
      route: this.route,
      stage: name,
      durationMs: stage.durationMs,
      ...metadata
    });

    return stage;
  }

  flush(metadata?: Record<string, unknown>): void {
    log("pipeline.trace.completed", {
      traceId: this.traceId,
      sessionId: this.sessionId,
      route: this.route,
      totalMs: Date.now() - this.startedAt,
      stages: this.stages.map((stage) => ({
        name: stage.name,
        durationMs: stage.durationMs
      })),
      ...metadata
    });
  }

  getStageSummaries(): Array<{
    name: string;
    durationMs: number;
  }> {
    return this.stages.map((stage) => ({
      name: stage.name,
      durationMs: stage.durationMs
    }));
  }
}
