import { createElement, type ReactNode } from "react";
import { SwitchAction } from "../../switch/entry";

/**
 * The seam for controls that sit beside "Sign out" on the account card, in order. WEB-08b shipped it empty (D-8b-08, G-20); WEB-08c
 * appends "Switch account", which opens WF-SWITCH-01 (the switch journey itself is lazily loaded). Each entry is a function so it can
 * use hooks.
 */
export const accountActions: readonly {
  readonly id: string;
  readonly render: () => ReactNode;
}[] = [{ id: "switch-account", render: () => createElement(SwitchAction) }];
