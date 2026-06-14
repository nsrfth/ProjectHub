import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Max nested automation events per originating user action (loop guard). */
export const MAX_AUTOMATION_DEPTH = 5;

/**
 * Carried through a single originating event chain. Shared `firedRules` ensures
 * each (ruleId, taskId) pair runs at most once; `depth` increments on each
 * nested post-commit automation dispatch triggered by an action mutation.
 */
export interface AutomationExecutionContext {
  chainId: string;
  depth: number;
  firedRules: Set<string>;
}

export const automationStore = new AsyncLocalStorage<AutomationExecutionContext>();

export function createRootContext(): AutomationExecutionContext {
  return {
    chainId: randomUUID(),
    depth: 0,
    firedRules: new Set<string>(),
  };
}

export function childContext(parent: AutomationExecutionContext): AutomationExecutionContext {
  return {
    chainId: parent.chainId,
    depth: parent.depth + 1,
    firedRules: parent.firedRules,
  };
}

export function ruleFireKey(ruleId: string, taskId: string): string {
  return `${ruleId}:${taskId}`;
}

export function getActiveContext(): AutomationExecutionContext | undefined {
  return automationStore.getStore();
}
