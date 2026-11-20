import type { AppContext } from '../context.js';

/** What an extension wants done around one group creation. */
export interface GroupCreatePlan {
  /** Called with the new group's id the instant WhatsApp has created it, before anything else */
  onCreated?(groupJid: string): void;
  /** After the group is fully set up: fields to add to the response */
  respond?(group: { id: string }): Record<string, unknown> | undefined;
  /** Always called last, whether the creation worked or not */
  settled?(): void;
}

/**
 * Lets an extension add a field to the body of POST /api/groups and act on it.
 * prepare is called before the group is created, only when the field is present. It returns
 * a plan, or a refusal: then no group is created.
 */
export interface GroupCreateHook {
  /** The body field this hook reads */
  field: string;
  prepare(
    ctx: AppContext,
    value: unknown,
  ): GroupCreatePlan | { refuse: { status: 400 | 409; body: object } };
}

const hooks: GroupCreateHook[] = [];

export function registerGroupCreateHook(hook: GroupCreateHook): void {
  if (!hooks.some((h) => h.field === hook.field)) hooks.push(hook);
}

/** For tests: forget every hook. */
export function clearGroupCreateHooks(): void {
  hooks.length = 0;
}

export function groupCreateHooks(): readonly GroupCreateHook[] {
  return hooks;
}
