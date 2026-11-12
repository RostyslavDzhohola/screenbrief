// A touch detector that always throws, to prove the pipeline carries on without it.
export async function detectTouches() {
  throw new Error('detector exploded on purpose');
}
