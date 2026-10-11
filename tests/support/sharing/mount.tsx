import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { DataEnvProvider, type MergedResource } from "../../../src/data";
import {
  type SharingEnv,
  SharingEnvProvider,
} from "../../../src/features/sharing/env";
import { UiProviders } from "../../helpers/providers";
import { cacheRow } from "../data/rows";
import { type StubEnv, stubEnv } from "../data/ui-env";
import { type FakeSharingApi, fakeSharingApi, sharingEnv } from "./fake-api";

/** Renders a sharing screen over the data env double and a sharing env double; `setSharing` re-renders with a changed env (online...). */
export function mountSharing(
  ui: ReactNode,
  options: {
    env?: StubEnv;
    api?: FakeSharingApi;
    sharing?: Partial<SharingEnv>;
  } = {},
) {
  const env = options.env ?? stubEnv();
  const api = options.api ?? fakeSharingApi();
  let sharing = sharingEnv(api, options.sharing);
  const tree = (value: SharingEnv) => (
    <UiProviders>
      <DataEnvProvider env={env}>
        <SharingEnvProvider value={value}>{ui}</SharingEnvProvider>
      </DataEnvProvider>
    </UiProviders>
  );
  const view = render(tree(sharing));
  return {
    ...view,
    env,
    api,
    sharing: () => sharing,
    setSharing(over: Partial<SharingEnv>) {
      sharing = { ...sharing, ...over };
      view.rerender(tree(sharing));
    },
  };
}

export const RESOURCE = "55555555-5555-4555-8555-555555555555";

export function merged(
  over: Parameters<typeof cacheRow>[0] = {},
): MergedResource {
  const row = cacheRow({
    id: RESOURCE,
    kind: "person",
    label: "Water plants",
    version: 3,
    policy_version: 2,
    ...over,
  });
  return {
    base: row,
    effects: [],
    creates: [],
    createsTotal: 0,
    createsNext: null,
    merged: row,
  };
}
