import { Dialog } from "../../components/ui/dialog";
import { RadioCardGroup } from "../../components/ui/radio-card-group";
import { useTheme } from "../../design/ThemeProvider";
import type { AppearancePreference } from "../../design/theme";

/** WF-SETTINGS-05. The stored value is "auto"; the accepted design labels it "Match system". */
export const OPTIONS = [
  {
    value: "dark",
    label: "Dark",
    contractId: "appearance-dark",
    preview: <Preview kind="dark" />,
  },
  {
    value: "light",
    label: "Light",
    contractId: "appearance-light",
    preview: <Preview kind="light" />,
  },
  {
    value: "auto",
    label: "Match system",
    contractId: "appearance-auto",
    preview: <Preview kind="auto" />,
  },
] as const;

function Preview({ kind }: { kind: "dark" | "light" | "auto" }) {
  // Fixed colours by design: a preview of a theme shows that theme whatever theme is active. See base.css.
  if (kind === "auto") {
    return (
      <span className="appearance-preview appearance-preview--split">
        <span data-half="dark" />
        <span data-half="light" />
      </span>
    );
  }
  return (
    <span className="appearance-preview" data-preview={kind}>
      <i />
      <b />
    </span>
  );
}

export function AppearanceDialog({
  open,
  onClose,
  onCloseAutoFocus,
}: {
  open: boolean;
  onClose(): void;
  onCloseAutoFocus?(event: Event): void;
}) {
  const { preference, setPreference, persisted } = useTheme();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      initialFocusSelector='[role="radio"][data-state="checked"]'
      title="Appearance"
    >
      <div className="flex flex-col gap-4">
        <RadioCardGroup<AppearancePreference>
          label="Theme"
          value={preference}
          onValueChange={setPreference}
          options={OPTIONS}
        />
        {persisted ? null : (
          <p className="rounded-row border border-missed-edge bg-missed-tint p-3 text-[12.5px] leading-[1.6] text-ink-1">
            This browser can't save your choice, so it will reset when you
            reload.
          </p>
        )}
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          Saved for this browser only, so a shared computer doesn't inherit your
          choice.
        </p>
      </div>
    </Dialog>
  );
}
