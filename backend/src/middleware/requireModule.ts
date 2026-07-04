import type { preHandlerHookHandler } from 'fastify';
import { Errors } from '../lib/errors.js';
import type { ModuleKey } from '../lib/moduleRegistry.js';
import { ProfilesService } from '../services/profilesService.js';

const profiles = new ProfilesService();

// v1.98 (PMIS R2 — project profiles): the reusable profile gate every future
// Wave-B/C module route will install. It loads the project's effective-config
// and 403s with the stable code `module_disabled` when the module is off for
// this project's profile. ADDITIVE to RBAC: it can only HIDE a capability a
// role grants — it never grants one.
//
// Use AFTER requireAuth + a team/project-access gate (it relies on
// :teamId/:projectId being present + the caller already having project access).
// The neutral core is NEVER gated by this — only the optional modules are.
// Nothing consumes it yet; it's the foundation Wave B builds on.
export function requireModule(moduleKey: ModuleKey): preHandlerHookHandler {
  return async (request) => {
    if (!request.user) throw Errors.unauthorized();
    const params = request.params as { teamId?: string; projectId?: string };
    if (!params.teamId || !params.projectId) {
      throw Errors.internal('requireModule installed on a route without :teamId / :projectId');
    }
    const enabled = await profiles.isModuleEnabled(params.teamId, params.projectId, moduleKey);
    if (!enabled) {
      throw Errors.moduleDisabled(moduleKey);
    }
  };
}
