import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { RadioCardGroup } from "../components/ui/radio-card-group";
import { RecoveryBanner } from "../lib/form-recovery/RecoveryBanner";
import { UpdatePrompt } from "../lib/form-recovery/UpdatePrompt";

/**
 * FIXTURE ONLY. Every shared control in one place, so real-browser tests can measure the input-border contrast (Q17),
 * the focus ring and the axe rules in both themes.
 */
export function ControlsGallery() {
  const [choice, setChoice] = useState("a");
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex max-w-[620px] flex-col gap-6 p-6"
    >
      <h1 className="text-[26px] font-semibold text-ink-1" data-page-heading="">
        Controls
      </h1>
      <section
        aria-label="On the page"
        className="flex flex-col gap-3 bg-canvas p-4"
        data-surface="canvas"
      >
        <Input label="Empty input on canvas" data-testid="input-canvas" />
        <Input label="Filled input on canvas" defaultValue="Water plants" />
      </section>
      <section
        aria-label="On a panel"
        className="flex flex-col gap-3 bg-panel p-4"
        data-surface="panel"
      >
        <Input
          label="Empty input on panel"
          surface="panel"
          data-testid="input-panel"
        />
        <Input
          label="Input with placeholder"
          surface="panel"
          placeholder="Type here"
        />
      </section>
      <section
        aria-label="Buttons"
        className="flex flex-wrap items-start gap-3"
      >
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="quiet">Quiet</Button>
        <Button disabled reason="You are offline, so this cannot be sent yet.">
          Send now
        </Button>
      </section>
      <RadioCardGroup
        label="Example choice"
        value={choice}
        onValueChange={setChoice}
        options={[
          { value: "a", label: "First" },
          { value: "b", label: "Second" },
          { value: "c", label: "Third" },
        ]}
      />
      <UpdatePrompt onSaveAndReload={() => {}} onNotNow={() => {}} />
      <RecoveryBanner
        state={{
          kind: "save-failed",
          onRetry: () => {},
          onDiscardAndReload: () => {},
        }}
      />
      <RecoveryBanner state={{ kind: "restored", onDiscard: () => {} }} />
    </main>
  );
}
