import "./styles/index.css";
import { boot } from "./app/boot";

/**
 * Production entry. The static shell has already loaded gated (`#protected-root` is inert and `aria-hidden`, the neutral gate is
 * visible), and nothing here lifts it: only the session's `act` does. This module never imports the gate primitives (lint rule
 * R4). The boot sequence is `src/app/boot.tsx`.
 */
const neutralRoot = document.getElementById("neutral-root");
if (!neutralRoot) throw new Error("Missing neutral root");
void boot({ neutralRoot });
