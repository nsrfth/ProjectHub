/** Toggle one task's subtask disclosure in the list view (in-memory session state). */
export function toggleExpandedTaskIds(current: ReadonlySet<string>, taskId: string): Set<string> {
  const next = new Set(current);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  return next;
}
