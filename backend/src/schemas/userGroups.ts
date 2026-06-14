import { z } from 'zod';

export const createUserGroupBody = z.object({
  name: z.string().min(1).max(120).trim(),
  description: z.string().max(2000).trim().nullable().optional(),
});

export const updateUserGroupBody = z.object({
  name: z.string().min(1).max(120).trim().optional(),
  description: z.string().max(2000).trim().nullable().optional(),
}).refine(
  (v) => v.name !== undefined || v.description !== undefined,
  'Provide at least one field to update',
);

export const addGroupMembersBody = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(200),
});

export const setGroupProjectsBody = z.object({
  projectIds: z.array(z.string().min(1)).max(500),
});

export const userGroupSummaryResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int(),
  grantedProjectCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const userGroupMemberResponse = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  addedAt: z.string(),
});

export const userGroupProjectResponse = z.object({
  projectId: z.string(),
  name: z.string(),
  ownerId: z.string().nullable(),
  grantedAt: z.string(),
});

export const userGroupDetailResponse = userGroupSummaryResponse.extend({
  members: z.array(userGroupMemberResponse),
  projects: z.array(userGroupProjectResponse),
});

export const userGroupsListResponse = z.object({
  items: z.array(userGroupSummaryResponse),
});

export type CreateUserGroupBody = z.infer<typeof createUserGroupBody>;
export type UpdateUserGroupBody = z.infer<typeof updateUserGroupBody>;
export type AddGroupMembersBody = z.infer<typeof addGroupMembersBody>;
export type SetGroupProjectsBody = z.infer<typeof setGroupProjectsBody>;
