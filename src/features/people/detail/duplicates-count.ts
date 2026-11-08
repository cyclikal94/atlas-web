import { useEffect } from "react";
import { usePeopleEnv } from "../env";
import { isCurrentMemory, useMemoryRevision } from "../memory";
import { firstPageCount } from "../model/duplicates";

/**
 * How many possible duplicates the server lists for a person (the first page's count, "2" or "2+"), read once per person into page memory
 * while online, for the facts strip's "Possible duplicate" cell and the actions' "Possible duplicates" entry. `null`: not known (offline,
 * an unsent person, still reading, or the read failed); never guessed.
 */
export function useDuplicateCount(
  personId: string,
  projected: boolean,
): string | null {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  useEffect(() => {
    if (!env.online || projected || env.memory.duplicateCounts.has(personId))
      return;
    const memory = env.memory;
    memory.duplicateCounts.set(personId, null);
    void env.api.readDuplicates(personId, { limit: 50 }).then((result) => {
      if (!isCurrentMemory(memory)) return;
      if (result.ok)
        memory.duplicateCounts.set(personId, firstPageCount(result.value));
      else memory.duplicateCounts.delete(personId);
      memory.touch();
    });
  }, [env, personId, projected]);
  if (!env.online || projected) return null;
  return env.memory.duplicateCounts.get(personId) ?? null;
}
