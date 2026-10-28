import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import pin from "../../../contract-pin.json";
import { capacityText } from "../../../src/features/settings/sessions-devices/CapacityLine";
import {
  BROWSER_TEXT,
  PLATFORM_TEXT,
} from "../../../src/features/settings/sessions-devices/label-copy";
import {
  checkDeviceName,
  clientLabelText,
  decodeCapacity,
  decodeClientLabel,
} from "../../../src/features/settings/sessions-devices/labels";
import { serverAcceptsName } from "../../support/session/server";

/**
 * WEB-08d: the decoders against the BE-Q25 contract. `tests/fixtures/be-q25/labels-and-capacity-30fec6a.json` is a verbatim extract
 * of backend commit 30fec6a (the schemas, the `behaviour.labels_and_capacity` probe payloads, and the name vectors of the backend's
 * own Rust tests). The accepted API 0.29 release retains these schemas: keep the original extract and compare it with the current
 * released contract, while checking that contract's bytes against the independently verified release pin.
 */
interface Extract {
  source: { commit: string; openapi_sha256: string };
  schemas: Record<string, Record<string, unknown>>;
  labels_and_capacity: Record<string, Record<string, unknown>>;
  name_vectors: { accepted: string[]; refused: string[] };
}
const extract = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../fixtures/be-q25/labels-and-capacity-30fec6a.json",
    ),
    "utf8",
  ),
) as Extract;
const require = createRequire(import.meta.url);
const releasedPath = require.resolve("@atlas/api-types/openapi.json");
const releasedBytes = readFileSync(releasedPath);
const released = JSON.parse(releasedBytes.toString("utf8")) as {
  info: { version: string };
  components: { schemas: Record<string, unknown> };
};

const enumOf = (schema: string, member: string): unknown[] => {
  const properties = extract.schemas[schema]?.properties as
    | Record<string, { enum: unknown[] }>
    | undefined;
  const values = properties?.[member]?.enum;
  if (!values) throw new Error(`no enum ${schema}.${member} in the extract`);
  return values;
};

describe("drift: the released contract preserves the BE-Q25 decoder contract", () => {
  test("the installed contract matches accepted API 0.29 and retains the original extract's provenance", () => {
    expect(extract.source.commit).toBe(
      "30fec6a3f31aaeea9c69d10216c78b8c02645661",
    );
    expect(extract.source.openapi_sha256).toBe(
      "087ced05e7a731d99b6374bbe0572e40746cec88dad0ce350c7bfe52fbf153fc",
    );
    expect(pin.backend_commit).toBe("4396c99300d00798fc10e61d459f4d9fce699ee8");
    expect(pin.contract_sha256).toBe(
      "369ca0de5ab0cd5983252b55d4a546263819c236fa285a386b0dd374bf82b6e0",
    );
    expect(createHash("sha256").update(releasedBytes).digest("hex")).toBe(
      pin.contract_sha256,
    );
    expect(released.info.version).toBe("0.29.0");
  });

  test.each(["ClientLabel", "Capacity", "DeviceName", "DeviceNameUpdate"])(
    "%s deep-equals the extract",
    (name) => {
      expect(released.components.schemas[name]).toEqual(extract.schemas[name]);
    },
  );
});

describe("every value of the closed enums has words", () => {
  test("each browser and platform the contract names has display text; `unknown` reads as a shortened label", () => {
    for (const browser of enumOf("ClientLabel", "browser"))
      if (browser !== null && browser !== "unknown")
        expect(BROWSER_TEXT, String(browser)).toHaveProperty(String(browser));
    for (const platform of enumOf("ClientLabel", "platform"))
      if (platform !== "unknown")
        expect(PLATFORM_TEXT, String(platform)).toHaveProperty(
          String(platform),
        );
    for (const channel of enumOf("ClientLabel", "channel"))
      for (const browser of enumOf("ClientLabel", "browser"))
        for (const platform of enumOf("ClientLabel", "platform")) {
          const label = decodeClientLabel({ channel, browser, platform });
          expect(label).not.toBeNull();
          const text = clientLabelText(label as NonNullable<typeof label>);
          expect(text).not.toMatch(/undefined|null|unknown|_/);
          expect(text.length).toBeGreaterThan(0);
        }
  });

  test("the schema examples decode to readable labels", () => {
    const examples = extract.schemas.ClientLabel?.examples as unknown[];
    expect(
      examples.map((raw) => {
        const label = decodeClientLabel(raw);
        return label ? clientLabelText(label) : null;
      }),
    ).toEqual(["Safari on iOS", "Atlas app on Android"]);
  });
});

describe("the backend's own name vectors get the same verdict", () => {
  test.each(extract.name_vectors.accepted.map((v) => [JSON.stringify(v), v]))(
    "accepted: %s",
    (_label, value) => {
      expect(checkDeviceName(value)).toBeNull();
      // The fake server's independent implementation agrees, so tests over it model the backend.
      expect(serverAcceptsName(value)).toBe(true);
    },
  );
  test.each(extract.name_vectors.refused.map((v) => [JSON.stringify(v), v]))(
    "refused: %s",
    (_label, value) => {
      expect(checkDeviceName(value)).not.toBeNull();
      expect(serverAcceptsName(value)).toBe(false);
    },
  );
});

describe("the probe payloads of behaviour.labels_and_capacity", () => {
  test("the sessions and devices probes decode: native iOS label, the device name, both capacities", () => {
    const sessions = extract.labels_and_capacity.sessions as Record<
      string,
      unknown
    >;
    const devices = extract.labels_and_capacity.devices as Record<
      string,
      unknown
    >;
    const label = decodeClientLabel(sessions.client);
    expect(label && clientLabelText(label)).toBe("Atlas app on iOS");
    expect(
      capacityText("sessions", decodeCapacity(sessions.session_capacity)),
    ).toBe("1 of 32 sign-ins in use.");
    // The listed device has only a session: it holds no place for syncing, so `used` is 0 although one device is listed.
    expect(capacityText("devices", decodeCapacity(devices.sync_capacity))).toBe(
      "0 of 32 places for syncing in use.",
    );
    expect(sessions.page_members).toEqual(["session_capacity", "sessions"]);
    expect(devices.item_members).toContain("name");
  });
});
