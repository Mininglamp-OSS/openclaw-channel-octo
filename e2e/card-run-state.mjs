// Host-side gated suite preflight. Pure validation: no Docker or filesystem I/O.
export function requireCardE2ERunState(env) {
  const fields = {
    container: 'OCTO_E2E_CONTAINER', targetUid: 'OCTO_E2E_TARGET_UID', runId: 'OCTO_E2E_RUN_ID',
    requestRoot: 'OCTO_E2E_REQUEST_ROOT', profile: 'OCTO_E2E_PROFILE', gatewayLog: 'OCTO_E2E_GATEWAY_LOG',
  };
  const state = Object.fromEntries(Object.entries(fields).map(([key, name]) => [key, env[name]?.trim() ?? '']));
  const missing = Object.entries(fields).filter(([key]) => !state[key]).map(([, name]) => name);
  const hint = 'Use npm run test:e2e:openclaw with an explicitly named idle dedicated container.';
  if (missing.length) throw new Error(`Missing required E2E run state: ${missing.join(', ')}. ${hint}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(state.container)) throw new Error(`Invalid OCTO_E2E_CONTAINER. ${hint}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.runId)) {
    throw new Error(`Invalid OCTO_E2E_RUN_ID. ${hint}`);
  }
  const root = `/var/lib/octo-host-e2e/runs/${state.runId}`;
  for (const [key, suffix] of [['profile', 'profile'], ['requestRoot', 'requests'], ['gatewayLog', 'gateway.log']]) {
    if (state[key] !== `${root}/${suffix}`) throw new Error(`${fields[key]} must match the owned OCTO_E2E_RUN_ID namespace. ${hint}`);
  }
  return Object.freeze(state);
}
