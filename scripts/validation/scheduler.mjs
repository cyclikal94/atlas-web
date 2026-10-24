// Bounded DAG admission. Only explicitly isolated pooled work may overlap.
export async function scheduleStage(
  steps,
  { limit = 1, mayOverlap, succeeded, stopped, execute },
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8)
    throw new Error("pool_parallelism must be an integer from 1 to 8");
  const pending = [...steps],
    active = new Map();
  let failure = null;
  const launch = (step) => {
    const promise = Promise.resolve()
      .then(() => execute(step, { requirePool: limit > 1 && mayOverlap(step) }))
      .catch((error) => {
        failure ??= error;
      })
      .finally(() => active.delete(step.id));
    active.set(step.id, promise);
  };
  while (pending.length || active.size) {
    if (failure || stopped()) {
      await Promise.all(active.values());
      break;
    }
    let admitted = false;
    while (active.size < limit && pending.length) {
      const at = pending.findIndex((step) =>
        (step.after ?? []).every(succeeded),
      );
      if (at < 0) break;
      const step = pending[at];
      const parallel = limit > 1 && mayOverlap(step);
      // An exclusive local step is a barrier. Do not overtake it.
      if (active.size && !parallel) break;
      pending.splice(at, 1);
      launch(step);
      admitted = true;
      if (!parallel) {
        await Promise.all(active.values());
        break;
      }
    }
    if (active.size) await Promise.race(active.values());
    else if (pending.length && !admitted && !stopped() && !failure)
      throw new Error(
        "Unmet stage dependencies; no validation step was launched",
      );
  }
  if (failure) throw failure;
}
