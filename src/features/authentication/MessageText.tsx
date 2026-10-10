import { MESSAGE_TEXT, type Message } from "./outcome-copy";

/** The request id line on its own (a leading space keeps the text content one sentence for a screen reader). */
export function RequestId({ id }: { id: string | undefined }) {
  if (!id) return null;
  return (
    <>
      {" "}
      <span data-request-id="" className="block text-[12px] text-ink-2">
        Request ID: {id}
      </span>
    </>
  );
}

/**
 * A catalogue message with its Atlas request id on a line of its own (a copyable reference, as the design's error banners
 * have). The text is the fixed catalogue sentence; the id is the only thing taken from the server, and it is rendered as text.
 */
export function MessageText({ message }: { message: Message }) {
  return (
    <>
      {MESSAGE_TEXT[message.id]}
      <RequestId id={message.requestId} />
    </>
  );
}
