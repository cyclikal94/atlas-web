/** `/tasks/lists` (the Lists pane), or `/tasks/lists/<id>` (a list): the public path helper of WEB-10b's routes. */
export const listPath = (listId?: string): string =>
  listId === undefined
    ? "/tasks/lists"
    : `/tasks/lists/${encodeURIComponent(listId)}`;
