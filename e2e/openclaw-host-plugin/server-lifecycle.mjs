// Retain the first failure after readiness as well as during bind. Attach a
// rejection observer immediately: callers can race failed without an unhandled
// rejection if an error arrives before their next request.
export function listenServer(server, port, onFailure) {
  let error, rejectReady, rejectFailed;
  const ready = new Promise((resolve, reject) => { rejectReady = reject; server.once("listening", resolve); });
  const failed = new Promise((_, reject) => { rejectFailed = reject; });
  failed.catch(() => {}); ready.catch(() => {});
  const fail = (cause) => {
    if (error) return;
    error = cause instanceof Error ? cause : new Error(String(cause));
    rejectReady(error); rejectFailed(error);
    try { onFailure?.(error); } catch (reportError) { console.error(`synthetic failure reporter: ${reportError.message}`); }
  };
  server.on("error", fail);
  try { server.listen(port, "127.0.0.1"); } catch (cause) { fail(cause); }
  return { ready, failed, fail, check() { if (error) throw error; }, get error() { return error; } };
}
