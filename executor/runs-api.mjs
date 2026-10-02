// The executor's calls to the Execute API, with the retry rules each one needs. Turns are idempotent by turn number,
// so a retried turn never makes a second model call.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function runsApi({ api, apiForm, runnerId }) {
  const post = (path, body) => api(path, 'POST', { runner_id: runnerId, ...body });
  return {
    runnerId,
    create: body => api('/execute/runs', 'POST', { ...body, runner_id: runnerId, start: true }),
    claim: id => post(`/execute/runs/${id}/claim`, {}),
    heartbeat: (id, body) => post(`/execute/runs/${id}/heartbeat`, body),
    steps: (id, steps) => post(`/execute/runs/${id}/steps`, { steps }),
    events: (id, events) => post(`/execute/runs/${id}/events`, { events }),
    finish: (id, body) => post(`/execute/runs/${id}/finish`, body),
    async artifact(id, { kind, filename, stepIndex, bytes, type }) {
      const form = new FormData();
      form.append('runner_id', runnerId);
      form.append('meta', JSON.stringify({ kind, filename, step_index: stepIndex ?? null }));
      form.append('file', new Blob([bytes], { type }), filename);
      return apiForm(`/execute/runs/${id}/artifacts`, form);
    },
    async turn(id, body, { signal } = {}) {
      let busy = 0, unavailable = 0;
      for (;;) {
        if (signal?.aborted) throw Object.assign(new Error('The run was stopped.'), { code: 'cancelled' });
        try {
          return await post(`/execute/runs/${id}/turns`, body);
        } catch (error) {
          // A turn still running (its response was lost) finishes on its own; the same turn number then replays it.
          if (error.status === 409 && /turn_in_progress/.test(error.message) && busy++ < 40) { await sleep(3000); continue; }
          if ((error.status === 503 || error.status === 502 || !error.status) && unavailable++ < 4) { await sleep(5000 * 2 ** (unavailable - 1)); continue; }
          throw error;
        }
      }
    },
  };
}
