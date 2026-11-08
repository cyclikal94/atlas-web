import { cn } from "../../lib/utils";

/** The first letter of a name, as the design's 24px avatars show it. */
export const initialOf = (name: string): string => {
  const trimmed = name.trim();
  return trimmed === "" ? "?" : ([...trimmed][0] ?? "?").toLocaleUpperCase();
};

/** A hue from an id or a name, so a person or a list keeps the same colour everywhere; fixed, never stored. */
export function hueOf(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

/**
 * A row of small overlapping initials (the Final design's "Seen by" and "Turn" cells). Decorative beside the words that name the
 * people; a lone stack states its names in a title.
 */
export function AvatarStack({
  people,
  max = 4,
  size = 24,
  highlight,
  className,
}: {
  people: readonly { id: string; name: string }[];
  max?: number;
  size?: 24 | 32;
  /** The one whose turn it is: filled with the primary colour. */
  highlight?: string;
  className?: string;
}) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span
      className={cn("flex flex-none items-center", className)}
      title={people.map((p) => p.name).join(", ")}
    >
      {shown.map((person, index) => (
        <span
          key={person.id}
          aria-hidden="true"
          className={cn(
            "flex items-center justify-center rounded-full border-2 border-background text-[10px] font-bold",
            size === 32 ? "size-8 text-xs" : "size-6",
            index > 0 ? "-ml-2" : "",
            highlight === person.id
              ? "bg-primary text-primary-foreground"
              : "bg-accent text-accent-foreground",
          )}
        >
          {initialOf(person.name)}
        </span>
      ))}
      {rest > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            "-ml-2 flex items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-muted-foreground",
            size === 32 ? "size-8 text-xs" : "size-6",
          )}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/** One avatar for a person's row or page: a coloured circle with their initial (32px on a row, 56px on their page). */
export function PersonAvatar({
  id,
  name,
  size = 32,
  className,
}: {
  id: string;
  name: string;
  size?: 24 | 32 | 56;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex flex-none items-center justify-center rounded-full font-bold text-background",
        size === 56
          ? "size-14 text-[22px]"
          : size === 24
            ? "size-6 text-[10px]"
            : "size-8 text-xs",
        className,
      )}
      style={{
        backgroundColor: `oklch(0.78 0.12 ${hueOf(id || name)})`,
      }}
    >
      {initialOf(name)}
    </span>
  );
}
