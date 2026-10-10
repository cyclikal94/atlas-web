import type { ReactNode } from "react";

/**
 * The seam WEB-08d uses if the BE-Q25 contract needs a control on this screen (for example a device name). WEB-08b ships it
 * EMPTY: its forms contain contract fields only, no label field and no capacity figure is invented (decision D-8b-13).
 */
export const signingInExtras: readonly {
  readonly id: string;
  readonly render: () => ReactNode;
}[] = [];
