/**
 * Test-owned lifetimes (R30/DA-H1, revision 25). A support object that keeps running after its test (an automatic driver of a fake
 * world, a dispatcher) registers how to end itself here; `tests/setup.ts` ends whatever a test created when that test is over, passed,
 * failed or timed out, and whatever a file created outside any test when the file is over. Nothing here imports the objects it ends, so
 * every test file can load it for nothing.
 */
type Ender = () => void | Promise<void>;

const fileScope: Ender[] = [];
let testScope: Ender[] | null = null;

/** Register `end` with the current test (or, outside a test, with the file). Returns a function that unregisters it. */
export function ownedByTest(end: Ender): () => void {
  const scope = testScope ?? fileScope;
  scope.push(end);
  return () => {
    const index = scope.indexOf(end);
    if (index >= 0) scope.splice(index, 1);
  };
}

/** Run every ender of a scope, newest first; all run, and the first failure is rethrown after them. */
async function endAll(scope: Ender[]): Promise<void> {
  let failure: unknown = null;
  let failed = false;
  while (scope.length > 0) {
    const end = scope.pop() as Ender;
    try {
      await end();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
}

export function beginTestLifetime(): void {
  testScope = [];
}

export async function endTestLifetime(): Promise<void> {
  const scope = testScope;
  testScope = null;
  if (scope) await endAll(scope);
}

export async function endFileLifetime(): Promise<void> {
  await endAll(fileScope);
}
