export function withFixtureServer<T>(
  root: string,
  run: (url: string) => Promise<T>,
): Promise<T>;
