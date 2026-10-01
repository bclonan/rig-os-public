import type { TaskContract } from "./index.js";

export type Run = {
  id: string;
  contract: TaskContract;
  status: string;
  cursor: number;
  skill: string;
  model: string;
  bindings: Record<string, unknown>;
  error?: string;
  wakeAt?: number;
};
