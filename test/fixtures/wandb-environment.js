// Explicit nonsecret worker command; no on-disk route discovery.
export function fixtureWorkerEnvironment() {
  return { SCUMMBENCH_WANDB_WORKER_COMMAND: JSON.stringify([process.execPath]) };
}
