import { Component, createRef, type ReactNode } from "react";

/**
 * Keeps the height its content had at the moment `held` turned on, until it turns off (WEB-13b revision 36, Review 43 F43-1 and the
 * design assessment's DA-1, family `task-detail-pending-layout-shift`).
 *
 * Content that drops controls while something is pending (the audience chooser while an enrolment change is sent and confirmed) would
 * otherwise move everything after it up, and the second press of a double press would land on whatever moved under the pointer. The
 * height is read at the RISING EDGE, before React applies that update to the page (`getSnapshotBeforeUpdate` runs before any DOM change
 * of the commit), and kept with an inline `min-height` set there and then, so no layout in between sees the collapsed content. That is why
 * this is a class: a layout effect runs only after the DOM has changed, and a height measured at the parent's earlier renders misses
 * every change the content makes on its own (a household picker opened, a membership read answered).
 *
 * - Turning on reserves the current height (nothing when it is 0); staying on keeps the first height, whatever the content does.
 * - Turning off releases it after the update is applied, so content that comes back fills the reserve without a jump.
 * - Mounting already on reserves nothing: nothing collapsed under a pointer.
 * - Only empty space is added: no content, role, name, focus stop or announcement. The wrapper is one plain `div`.
 *
 * The style is set on the element, never passed as a prop, so React never writes over it.
 */
export class HeldHeight extends Component<{
  held: boolean;
  children: ReactNode;
}> {
  private readonly box = createRef<HTMLDivElement>();

  override getSnapshotBeforeUpdate(previous: { held: boolean }): null {
    const element = this.box.current;
    if (element !== null && !previous.held && this.props.held) {
      const height = element.getBoundingClientRect().height;
      if (height > 0) element.style.minHeight = `${height}px`;
    }
    return null;
  }

  override componentDidUpdate(previous: { held: boolean }) {
    const element = this.box.current;
    if (element !== null && previous.held && !this.props.held)
      element.style.minHeight = "";
  }

  override render() {
    return (
      <div ref={this.box} data-held-height="">
        {this.props.children}
      </div>
    );
  }
}
