import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CompatibilityScreen } from "./app/CompatibilityScreen";
import {
  type CapabilityReport,
  checkCapabilities,
  probeCapabilities,
} from "./app/capabilities";
import { NeutralEntry } from "./app/NeutralEntry";
import { ThemeProvider } from "./design/ThemeProvider";
import "./styles/index.css";
import { NeutralGate } from "./components/ui/neutral-gate";

/**
 * Production entry: the neutral app only. It never mounts the protected tree and never imports the gate
 * primitives (lint rule R4), so #protected-root stays inert and empty. It does not touch location.hash,
 * because WEB-08b reads the OIDC grant from the URL fragment.
 */
function NeutralApp() {
  const [report, setReport] = useState<CapabilityReport | null>(() => {
    const presence = checkCapabilities();
    return presence.ok ? null : presence;
  });
  useEffect(() => {
    let cancelled = false;
    void probeCapabilities().then((result) => {
      if (!cancelled) setReport(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (report && !report.ok)
    return <CompatibilityScreen issues={report.issues} />;
  if (!report) return <NeutralGate heading="Atlas" message="Opening Atlas…" />;
  return <NeutralEntry />;
}

const neutralRoot = document.getElementById("neutral-root");
if (!neutralRoot) throw new Error("Missing neutral root");
createRoot(neutralRoot).render(
  <StrictMode>
    <ThemeProvider>
      <NeutralApp />
    </ThemeProvider>
  </StrictMode>,
);
