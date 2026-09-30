export interface NeutralGateProps {
  heading: string;
  message?: string;
}

/**
 * A neutral screen that shows nothing about any account. The backdrop is opaque canvas, not the translucent
 * modal scrim, so no protected pixels can show behind it (matrix section 3.7.2). index.html ships the same
 * markup statically, so a cold load is gated before any script runs.
 */
export function NeutralGate({ heading, message }: NeutralGateProps) {
  return (
    <dialog open className="neutral-gate" aria-labelledby="gate-heading">
      <div className="neutral-gate__body">
        <span aria-hidden="true" className="neutral-gate__mark" />
        <h1 id="gate-heading" tabIndex={-1}>
          {heading}
        </h1>
        <p role="status">{message}</p>
      </div>
    </dialog>
  );
}
