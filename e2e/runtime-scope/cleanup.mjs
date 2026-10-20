// Every resource gets its cleanup attempt, even if account shutdown rejects.
// Keep the original run failure; secondary cleanup errors remain observable.
export async function cleanupAll(steps, original) {
  const hasOriginal = arguments.length > 1;
  const errors = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (hasOriginal) {
    for (const error of errors) if (error !== original) console.error(`probe cleanup failed: ${error?.message ?? error}`);
    throw original;
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "probe cleanup failed");
}
