export interface AuthState {
  authenticated: boolean;
  hasPassword: boolean;
  onboarded: boolean;
}

export type AppScreen = "loading" | "error" | "onboarding" | "dashboard" | "login";

export interface AuthLoadState {
  auth: AuthState | null;
  error: string | null;
  loading: boolean;
}

export const initialAuthLoadState: AuthLoadState = {
  auth: null,
  error: null,
  loading: true,
};

/** Maps the current auth load state to the top-level screen App renders. */
export function authScreen(state: AuthLoadState): AppScreen {
  if (!state.auth) return state.error ? "error" : "loading";
  if (!state.auth.hasPassword || (state.auth.authenticated && !state.auth.onboarded)) return "onboarding";
  return state.auth.authenticated ? "dashboard" : "login";
}

/** Extracts a readable error message from a failed /auth request. */
export function formatAuthError(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim();
  if (typeof cause === "string" && cause.trim()) return cause.trim();
  return "Could not reach VM Bridge.";
}

export interface AuthLoader {
  refresh: () => Promise<void>;
  dispose: () => void;
}

/**
 * Coordinates /auth refreshes with generation fencing and failure recovery:
 * - Initial failures transition to an actionable error state instead of leaving a blank screen.
 * - Failures after auth has already loaded keep the current screen mounted and report via `onRefreshError`.
 * - Superseded or post-dispose responses are ignored so stale requests cannot overwrite newer auth state.
 */
export function createAuthLoader(
  fetchAuth: () => Promise<AuthState>,
  onState: (next: AuthLoadState, commitSync: boolean) => void,
  onRefreshError?: (message: string) => void,
): AuthLoader {
  let state: AuthLoadState = initialAuthLoadState;
  let generation = 0;
  let disposed = false;

  const update = (next: AuthLoadState, commitSync: boolean) => {
    const unchanged =
      state.auth === next.auth &&
      state.error === next.error &&
      state.loading === next.loading;
    state = next;
    if (!unchanged) onState(next, commitSync);
  };

  const refresh = async () => {
    if (disposed) return;
    const seq = ++generation;
    update({ auth: state.auth, error: state.error, loading: true }, false);
    try {
      const next = await fetchAuth();
      if (disposed || seq !== generation) return;
      // Committed synchronously on success so a view transition around it (finishing onboarding) captures the new screen.
      update({ auth: next, error: null, loading: false }, true);
    } catch (cause) {
      if (disposed || seq !== generation) return;
      const message = formatAuthError(cause);
      if (state.auth) {
        update({ auth: state.auth, error: null, loading: false }, false);
        onRefreshError?.(message);
      } else {
        update({ auth: null, error: message, loading: false }, false);
      }
    }
  };

  const dispose = () => {
    disposed = true;
    generation += 1;
  };

  return { refresh, dispose };
}
