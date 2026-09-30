/**
 * Which of the two servers a Playwright run needs. The production project needs the production build (dist/) and the fixture
 * project needs the fixture build (dist-fixture/); a run that selects only one must not start, or need the build of, the other.
 * Image and Compose smoke runs (scripts/smoke-image.sh, scripts/smoke-compose.sh) select `--project=production-chromium` on a
 * clean CI job that has never built the fixture, so starting `preview:fixture` there failed before any assertion ran.
 */
export const TARGETS = ["production", "fixture"] as const;
export type Target = (typeof TARGETS)[number];

const PROJECT = "--project";

/**
 * The project names on the command line, read as Playwright's own command line reads them (`--project <name...>` is variadic
 * with a space and takes exactly one value with `=`). Undefined when there is no filter, which means every project.
 */
export function projectFilters(argv: readonly string[]): string[] | undefined {
  const names: string[] = [];
  let seen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg.startsWith(`${PROJECT}=`)) {
      seen = true;
      names.push(arg.slice(PROJECT.length + 1));
    } else if (arg === PROJECT) {
      seen = true;
      while (index + 1 < argv.length && !argv[index + 1]?.startsWith("-")) {
        index += 1;
        names.push(argv[index] ?? "");
      }
    }
  }
  return seen ? names : undefined;
}

/** Playwright matches project names case-insensitively, and `*` is the only wildcard. */
function matcher(filter: string): (name: string) => boolean {
  const lower = filter.toLocaleLowerCase();
  if (!lower.includes("*")) return (name) => name === lower;
  const pattern = lower
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const expression = new RegExp(`^${pattern}$`);
  return (name) => expression.test(name);
}

/**
 * The servers the selected projects need. `projectNames` are the configured names, `<target>-<browser>`. With no filter, or a
 * filter that matches nothing (Playwright then reports the unknown name itself), every server is needed.
 */
export function neededTargets(
  argv: readonly string[],
  projectNames: readonly string[],
): ReadonlySet<Target> {
  const filters = projectFilters(argv);
  if (!filters) return new Set(TARGETS);
  const matchers = filters.map(matcher);
  const needed = new Set<Target>();
  for (const name of projectNames) {
    const lower = name.toLocaleLowerCase();
    if (!matchers.some((matches) => matches(lower))) continue;
    for (const target of TARGETS) {
      if (lower.startsWith(`${target}-`)) needed.add(target);
    }
  }
  return needed.size > 0 ? needed : new Set(TARGETS);
}
