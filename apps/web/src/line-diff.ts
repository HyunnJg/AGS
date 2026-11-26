// Zero-based, half-open ranges within the changed window returned by the server.
export type LineChange = { oldStart: number; oldEnd: number; newStart: number; newEnd: number };
type Chain = { range: LineChange; previous?: Chain | undefined };
type Position = { old: number; next: number; tail?: Chain | undefined };

export function lineDiff(before: string[], after: string[]): { changes: LineChange[]; grouped: boolean } {
  const whole = { oldStart: 0, oldEnd: before.length, newStart: 0, newEnd: after.length };
  if (!before.length || !after.length)
    return { changes: before.length || after.length ? [whole] : [], grouped: false };

  // Bounded Myers search. Each diagonal retains the path that advanced furthest.
  // Dense rewrites use one complete before/after view instead of blocking the editor.
  const maxEdits = 128;
  if (Math.abs(before.length - after.length) > maxEdits) return { changes: [whole], grouped: true };
  let comparisons = 0;
  function skipEqual(pos: Position) {
    while (pos.old < before.length && pos.next < after.length && before[pos.old] === after[pos.next]) {
      pos.old++;
      pos.next++;
      comparisons++;
    }
    return pos;
  }
  const start = skipEqual({ old: 0, next: 0 });
  if (start.old === before.length && start.next === after.length) return { changes: [], grouped: false };
  let frontier = new Map<number, Position>([[0, start]]);
  for (let distance = 1; distance <= maxEdits; distance++) {
    const nextFrontier = new Map<number, Position>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (comparisons > 2_000_000) return { changes: [whole], grouped: true };
      const add = frontier.get(diagonal + 1);
      const remove = frontier.get(diagonal - 1);
      const canRemove = remove && remove.old < before.length;
      const inserting = add && add.next < after.length && (!canRemove || add.old > remove.old);
      const previous = inserting ? add : canRemove ? remove : undefined;
      if (!previous) continue;
      const oldEnd = previous.old + (inserting ? 0 : 1);
      const newEnd = previous.next + (inserting ? 1 : 0);
      const last = previous.tail;
      const adjacent = last && last.range.oldEnd === previous.old && last.range.newEnd === previous.next;
      const range = {
        oldStart: adjacent ? last.range.oldStart : previous.old,
        oldEnd,
        newStart: adjacent ? last.range.newStart : previous.next,
        newEnd,
      };
      const tail = { range, previous: adjacent ? last.previous : last };
      const pos = skipEqual({ old: oldEnd, next: newEnd, tail });
      if (pos.old === before.length && pos.next === after.length) {
        const changes: LineChange[] = [];
        for (let link: Chain | undefined = tail; link; link = link.previous) changes.push(link.range);
        return { changes: changes.reverse(), grouped: false };
      }
      nextFrontier.set(diagonal, pos);
    }
    frontier = nextFrontier;
  }
  return { changes: [whole], grouped: true };
}
