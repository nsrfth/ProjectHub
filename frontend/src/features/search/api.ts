import { api } from '@/lib/api';

export type SearchType = 'task' | 'comment' | 'project';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'ON_HOLD' | 'REVIEW' | 'DONE';

interface BaseHit {
  rank: number;
}

export interface TaskHit extends BaseHit {
  type: 'task';
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  projectName: string;
  teamId: string;
  teamName: string;
  excerpt: string | null;
}

export interface CommentHit extends BaseHit {
  type: 'comment';
  id: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  teamId: string;
  teamName: string;
  excerpt: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
}

export interface ProjectHit extends BaseHit {
  type: 'project';
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  excerpt: string | null;
}

export interface Bucket<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SearchResults {
  tasks: Bucket<TaskHit>;
  comments: Bucket<CommentHit>;
  projects: Bucket<ProjectHit>;
}

export interface SearchParams {
  q: string;
  type?: SearchType;
  taskCursor?: string;
  commentCursor?: string;
  projectCursor?: string;
  limit?: number;
}

export async function searchAll(params: SearchParams): Promise<SearchResults> {
  return (await api.get<SearchResults>('/search', { params })).data;
}
