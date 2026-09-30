import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/** The policy the frontend container really sends, read from deploy/nginx/security-headers.conf. */
export function containerHeaders(): Record<string, string> {
  const source = readFileSync("deploy/nginx/security-headers.conf", "utf8");
  const headers: Record<string, string> = {};
  for (const match of source.matchAll(/^add_header\s+(\S+)\s+"([^"]*)"/gm)) {
    if (match[1] && match[2]) headers[match[1].toLowerCase()] = match[2];
  }
  return headers;
}

/**
 * Serves every response with the container's security headers and records every violation. This proves the client
 * satisfies the policy in any browser; B10/smoke-image repeats it through the real nginx configuration.
 */
export async function enforceContainerPolicy(page: Page): Promise<string[]> {
  const headers = containerHeaders();
  const policy = headers["content-security-policy"];
  if (!policy)
    throw new Error(
      "No Content-Security-Policy in deploy/nginx/security-headers.conf",
    );
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), ...headers },
    });
  });
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __violations: string[] }).__violations = violations;
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(
        `${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`,
      );
    });
  });
  return [];
}

export const violations = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __violations?: string[] }).__violations ?? [],
  );
