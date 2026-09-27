import { useReducer, type SetStateAction } from 'react';

interface Running {
  running: boolean;
}

const set = (current: Running, action: SetStateAction<boolean>): Running => ({
  running: typeof action === 'function' ? action(current.running) : action,
});

/**
 * Whether a Lab's simulation runs, used like `useState(true)`: pass `setRunning` to LabShell as
 * `onRunningChange`. LabShell pauses the Lab after every Reset (see "A new interactive lab" in
 * CLAUDE.md). One difference from useState: every set re-renders the Lab, even to the value it
 * already has. A Lab keeps its simulation in refs, which React does not see change, so without
 * that a Reset of a paused Lab would clear the refs and still show the old frame.
 */
export function useLabRunning(initial = true) {
  const [state, setRunning] = useReducer(set, { running: initial });
  return [state.running, setRunning] as const;
}
