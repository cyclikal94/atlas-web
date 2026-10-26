import { useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { NativeSelect } from "../components/ui/native-select";
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
      <h1
        className="text-2xl font-semibold text-foreground"
        data-page-heading=""
      >
        Controls
      </h1>
      <section
        aria-label="On the page"
        className="flex flex-col gap-3 bg-background p-4"
        data-surface="canvas"
      >
        <Input label="Empty input on canvas" data-testid="input-canvas" />
        <Input label="Filled input on canvas" defaultValue="Water plants" />
      </section>
      <section
        aria-label="On a panel"
        className="flex flex-col gap-3 bg-card p-4"
        data-surface="panel"
      >
        <Input label="Empty input on panel" data-testid="input-panel" />
        <Input label="Input with placeholder" placeholder="Type here" />
        <div className="flex flex-col gap-2">
          <Label htmlFor="gallery-select">Native select</Label>
          <NativeSelect id="gallery-select" defaultValue="b">
            <option value="a">Morning</option>
            <option value="b">Afternoon</option>
          </NativeSelect>
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox id="gallery-check" defaultChecked />
          <Label htmlFor="gallery-check">Checkbox</Label>
        </div>
      </section>
      <section
        aria-label="Buttons"
        className="flex flex-wrap items-start gap-3"
      >
        <Button variant="default">Primary</Button>
        <Button variant="outline">Secondary</Button>
        <Button variant="ghost">Quiet</Button>
        <Button variant="destructive">Destructive</Button>
        <Button disabled reason="You are offline, so this cannot be sent yet.">
          Send now
        </Button>
      </section>
      <section aria-label="Badges" className="flex flex-wrap gap-2">
        <Badge variant="success">Done</Badge>
        <Badge variant="warning">Missed</Badge>
        <Badge variant="destructive">Conflict</Badge>
        <Badge variant="accent">On track</Badge>
        <Badge variant="muted">Not sent yet</Badge>
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
