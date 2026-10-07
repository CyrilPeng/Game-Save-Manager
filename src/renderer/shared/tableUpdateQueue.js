/** Serialize table reloads and keep only the latest pending action for each row. */
function createTableUpdateQueue({
  setBusy,
  showLoading,
  hideLoading,
  updateRow,
  removeRow,
  onError,
}) {
  const states = new Map();
  const stateFor = (tab) => {
    if (!states.has(tab))
      states.set(tab, { promise: null, full: null, rows: new Map() });
    return states.get(tab);
  };
  function start(tab, state) {
    if (state.promise) return state.promise;
    // Start on a microtask so callers always see the same active promise.
    state.promise = Promise.resolve()
      .then(async () => {
        let loading = false;
        setBusy(tab, true);
        try {
          while (state.full || state.rows.size) {
            if (state.full) {
              const request = state.full;
              state.full = null;
              try {
                if (request.loader && !loading) {
                  loading = true;
                  await showLoading(tab);
                }
                await request.load();
              } catch (error) {
                onError(tab, error);
              }
            } else {
              const [key, action] = state.rows.entries().next().value;
              state.rows.delete(key);
              try {
                if (action.type === 'remove') await removeRow(tab, action.id);
                else await updateRow(tab, action.id);
              } catch (error) {
                onError(tab, error);
              }
            }
          }
        } finally {
          if (loading) hideLoading(tab);
          setBusy(tab, false);
        }
      })
      .finally(() => {
        state.promise = null;
        if (state.full || state.rows.size) start(tab, state);
      });
    return state.promise;
  }
  return {
    reload(tab, loader, load) {
      const state = stateFor(tab);
      state.full = { loader: Boolean(loader || state.full?.loader), load };
      return start(tab, state);
    },
    update(tab, id) {
      const state = stateFor(tab);
      state.rows.set(String(id), { type: 'update', id });
      return start(tab, state);
    },
    remove(tab, id) {
      const state = stateFor(tab);
      state.rows.set(String(id), { type: 'remove', id });
      return start(tab, state);
    },
  };
}
module.exports = { createTableUpdateQueue };
