# Final design: what is not yet aligned, and the phases to make it airtight

Written 8 November 2026 after Kieran's fifth review, against the 24 frames of "Atlas layout redesign.html" (unpacked to
`page-00` … `page-23`; the frame names below are the export's). Each item names the frame, what the app does today, and what
closes the gap. The phases are ordered so that each leaves the app consistent on its own.

## A. What is wrong today (screen by screen)

**Today / Upcoming (frames `today`, `FD_TodayScrolled`, `FD_TodayPhone`)**
- The date is written twice (the large title and the sticky bar). The frame has ONE header: scrolled, "the section heading
  becomes the sticky bar". So the large header must stay (eyebrow, title, summary, controls) and its TITLE must become the section
  under it: "Sunday 8 November" → "Tomorrow · Monday 9 November" → "Rest of week · Tuesday 10 November", with the eyebrow turning
  from TODAY to UPCOMING. No small bar at all. (The calendar now does exactly this; Today must match it.)
- The day's controls (‹ date ›, the filters, the zone) belong in that header's second row, not on a bar.
- The reveal of the days ahead must be instant and decisive: reaching the end and scrolling on jumps to "Tomorrow" at once (no
  220 px pull, no purple progress line). The pill does the same. Keep the fold closed by default.
- Verbosity to remove: "Planned with the server through …" (keep only an error state), "From this device …" captions, the
  "Just me · 10 / 1 bills · Done" row note is fine; the "Sharing checked at 11:24 …" line on People; "Lists don't change who can
  see a task …" on a list; "Only tasks you can already see …" in the picker; "+N more" is fine.
- Rows: the frame's row carries ONE grey fact (who, "Sam's turn", "needs the recycling first", a count badge); ours shows
  "Anyone · You · To do", a status word the tick already shows. Trim to the one fact.
- The frame's "Upcoming" blocks fold routine tasks to "2 daily tasks · brush your teeth, tidy room · show": ours says "1 routine
  task · show" without the names.
- Motion: none today. The frame implies a rail that "continues", rows that settle in, a tick that completes.

**Task (`task`, `FD_TaskPhone`, `FD_EditDialog`, `FD_EditPopover`)**
- Facts strip is right in shape; missing cells: Turn (avatars + "you next"), Timer with the control INSIDE the cell, Reminder,
  Follows. The Timer cell exists only as "goal or timer"; the reminder and follows cells are not drawn (no backend for
  reminders; "Follows" exists through dependencies).
- Short choices (reminder, who, repeats) should open as a POPOVER under the pressed cell (`FD_EditPopover`); consequential
  editors (sharing, rota, follows) as the centred dialog (`FD_EditDialog`). Today every edit goes to the form page.
- Activity column: ours is the entry history; the frame's activity is a timeline of sentences ("Did it · 9 min · 6 weeks
  running") with "Add a note". Notes do not exist in the backend; the sentence form does.
- The phone frame has a sticky Done / Skip / Timer bar; ours has the record row sticky. Align the three buttons.

**Create / Edit (`FD_Create`, `FD_CreatePhone`)**
- The frame's title field parses natural text into chips ("Fri 30", "#desk", "every …"); ours is a plain field.
- Facts as a grid of BUTTONS with the chosen editor as a popover under the pressed one (When: quick chips, month grid, time
  row). Ours jumps to grouped sections below. The "Looks like" aside (templates, duplicates) has no backend; leave it.
- "Add task" / "Add and another", "Draft kept if you click away": ours has Save only.
- Remove the buttons that lead to the Sync page from the form and the dialogs (the queue is reachable from the status chip).

**Calendar (`FD_Calendar`, `FD_CalendarPeople`, `FD_CalendarImport`, `FD_CalendarPhone`)**
- Header: keep as it now is (it stays, the month once). Fix: the title must never truncate (the page header's title column
  now keeps its width; verify in Safari after the HMR). Add the frame's "Show" row: people chips (avatars, Everyone), the
  Task / Calendar event / Birthday chips (events and birthdays from people's birthday fields; calendar events have no backend
  yet, so that chip is present but empty), "Sources · n / Import a file" only when the calendar events slice lands.
- Grid: ONE box per month with square hairlines between cells and rounded outer corners (the facts-strip look), not separate
  rounded cards; cells a FIXED height (3 rows then "+N more" inside it) so days with and without things are the same size; the
  neighbouring months' days dimmed; "1 Nov" on the first.
- People view (`FD_CalendarPeople`): a third view, "People": a lane per household member (the account's people with linked
  accounts, plus "Anyone · whose turn" from the rota), the week's days as columns, each task a chip in the lane of who does it,
  "Balance this week" counts at the right. Drag between lanes is a later phase (needs a hand-over command).
- Phone (`FD_CalendarPhone`): the small grid then the agenda is right; add the "Everyone / Kieran / Alex …" people chips row.

**People / Person (`FD_People`, `FD_Person`, `FD_PeoplePhone`, `FD_PersonPhone`)**
- Rows must be grouped: "The Lane household" (in your home), "Shared with you" (by whom · read only), "Just you", "Archived · n";
  one fact per row ("8 · birthday 14 Nov", "linked account", "by Alex · read only"), a badge only when something needs you
  ("1 duplicate?", "merge?"). Ours is one flat list with "Added by you · Not linked to an account · Visible to: Only you".
- A row opens the person IN THE SAME CONTAINER AS TASKS (the frame says so); ours opens a page.
- Person: the facts strip needs Seen by (avatars), Account, Birthday ("14 Nov · in 19 days"), Tasks about (count), Possible
  duplicate (compare); the fields as ONE grouped box with type and audience as grey notes only where they differ; "+ Add a
  field" as the box's last row; activity beside as sentences.

**Lists / List (`FD_Lists`, `FD_List`)**
- Rows: colour, name, "who shares it · one fact", open count; groups Pinned / Household / Just you / Archived · n. Ours has
  "All lists" only and no sharing fact.
- A list: eyebrow "List", summary "9 to get · shared with the household", the "Add" pill at the right (not an "Add task to list"
  row), items with who-added avatars, a "needed by the bins task" fact with the yellow badge, "Ticked · n" group and "Clear
  ticked". Ours lacks the groups and the facts. Items open in the chosen container (already wired; verify at ≥ 1280 px).

**Timers (`FD_Timers`)**: "Running now" rows with Stop / Discard, "Earlier this week" rows ("Sun 16:10 → 16:48 · 38 min"),
"Goals this week" aside with the bar per task; This week / This month / All pills. Ours is close; the goals aside is missing.

**Focus (`FD_Focus`, `FD_FocusPhone`)**: the desktop frame's acts are Done D / Later L / Skip S / Timer T with the keys shown on
the buttons, a "Meanwhile" aside of what others did; the phone frame is a ring timer with Pause / Done for today / Discard. Ours
has D/S/←/→ and the day in order; add Later, Timer, the key caps and the phone ring.

**Settings (`FD_TaskWrappers`)**: sections open inconsistently (Appearance a dialog, Layout a page, Sessions a page). Every
section must open the same way, and the frame says the container setting "also applies to creating a task, people and lists".
Decision for the plan: rename the setting "How things open" and apply it to tasks, task creation, people, lists AND settings
sections; the phone always a page.

**Sharing (`/sharing`, no frame)**: untouched by the redesign. Bring it onto the row design: a page header, grouped rows
(defaults, shared items, requests), the sharing editor as the `FD_EditDialog` grouped box. Or fold it into People (Requests)
and the task's "Seen by" and retire the page.

**Shell**: the rail is right; the account row and status chip are right. Missing: motion.

**Seen in the full screen capture of 8 November 2026 (43 screens, desktop and phone), beyond the above**
- Task: the record area reads "10 / 1 bills today · Log an amount / Just checked on it · Amount (bills) · Record · Correct this day ·
  Saves offline and sends when you're back online": five lines where the frame has one action row. The aside's "Recent entries" are
  cards ("Checked on it · by you · 09:45" three times) rather than the frame's sentences; "Who's on this" explains itself ("Only you
  do this."). The split pane, the side peek and the overlay work.
- New task: a preset picker dialog ("Start from a preset…") sits over the page; the frame opens the task page in edit mode directly,
  with templates offered in the "Looks like" aside. Phase 11 folds the presets into that aside.
- People: one flat row, "Added by you · Not linked to an account · Visible to: Only you · 2 fields", and the "Sharing checked at
  12:48 …" caption; the frame has one fact per row and groups.
- Person: the fields box carries "Only you / Nobody else can see it." under every field and Edit / Archive buttons on each; the frame
  shows a value with a grey note only where the audience differs, editing from the row. "Shared with" and "New fields start as" are
  explanatory boxes to retire into the facts strip ("Seen by").
- Sharing: grouped boxes of prose with an inline "Create a household" form; no row design.
- Focus: right in shape; Later, Timer and the frame's key caps are missing. Timers: the empty state is fine; the goals aside is missing.
- Settings: Appearance opens a dialog, the rest are pages.

## B. Cross-cutting

1. **Motion and feel.** A motion system (`design/motion.css`): durations 120/200/320 ms, one ease-out and one spring; page
   enter (fade + 8 px rise, staggered rows via `atlas-stagger`), the tick's completion (scale pop + the row settling), the fold
   reveal (the rail "continuing", rows cascading in), the pane / peek / overlay entering from their edge, the calendar's glide and
   the month title cross-fading as it takes over, the picker popping from its button, hover/press states on every row and pill,
   skeletons that shimmer. All under `prefers-reduced-motion`.
2. **Copy pass.** Remove explanatory captions from every screen (the plan lists them above); facts, not sentences.
3. **One container setting** ("How things open") driving tasks, creation, people, lists and settings.
4. **Verification.** Every phase ends with the Safari harness capturing each screen at 1440 and 390 and a side-by-side against
   the frame; no phase is "done" from jsdom alone.

## C. Phases

Progress (8 November 2026, evening): Phase 6 is done except the row's one fact and the routine fold naming its tasks (moved to Phase
9 with the rest of the row work); the calendar's one-box grid with cells of one height (from Phase 7) was brought forward because the
review asked for it. One decision is held for Kieran: the dialogs' sync chip ("Updates stopped" / the green dot beside Close in New
person, New list, the editors) is the documented "in-dialog sync control" (WEB-10a decisions 49-50, revision 18 R33: it keeps the
dialog's input across a visit to the sync screens) and some forty unit and e2e cases exercise it; removing it outright is a contract
change, so Phase 11 proposes hiding it while the state is "up to date" and keeping it when something needs the person.

- **Phase 6 — Today's one header (done).** The large header stays and names the section (title and eyebrow change as you
  scroll); the day's controls moved into it; the small bar is gone; the reveal is an instant jump to "Tomorrow" with no progress
  line; the "Planned with the server…", "From this device…" and "Saves offline…" captions are gone; the calendar's month is one box of
  hairlined cells of one height and its title no longer truncates. Left for Phase 9: the row's one fact; routine folds naming their
  tasks. On the phone the header scrolls with the page (stuck, it took half the screen); Phase 13 gives the phone a compact one.
- **Phase 7 — Calendar grid and People view (done).** The one-box month grid with fixed cells (in phase 6); the "Show" row of
  the household's chips and Everyone, narrowing every view to one person; the People lanes view (`view=people`) with the "Anyone ·
  whose turn" lane, "Others" and the weekly balance, a lane at a time on the phone. Not done, for want of data: the Task /
  Calendar event / Birthday chips (no events, no birthday field kind), "Sources · n / Import a file", dragging between lanes.
- **Phase 8 — One container everywhere (done, bar the settings).** "How things open" applied to people rows (`/people?person=`),
  All-tasks rows (`/tasks?task=`) and list rows (`/tasks/lists?list=`); the person and the list drawn `embedded` inside TaskPane;
  Settings' Appearance a page like the rest, so every section opens the same way. Settings sections inside the container wait for
  the registry to expose each section's screen (today it builds routes only).
- **Phase 9 — People and Lists on the frames.** Grouped rows with one fact and badges; the person's facts strip and fields box;
  lists' groups and sharing facts; the list's "Add" pill, who-added avatars, "Ticked · n", "Clear ticked".
- **Phase 10 — Task editors as popovers and dialogs.** Short choices under the pressed cell; consequential editors as the
  centred dialog; Turn / Timer / Follows cells; the phone's Done / Skip / Timer bar; the activity as sentences.
- **Phase 11 — Create with chips.** The parsing title field (dates, times, "every …", people, #lists as chips); facts as
  buttons with popovers; "Add" / "Add and another"; drafts kept; no Sync buttons on forms or dialogs.
- **Phase 12 — Timers, Focus, Sharing.** The goals aside; Focus's Later / Timer / key caps / "Meanwhile" and the phone ring;
  Sharing on the row design or folded into People and "Seen by".
- **Phase 13 — Motion and feel.** The motion system across every surface, then a full screen-by-screen Safari pass at both
  widths against all 24 frames.

Each phase: typecheck, lint, the unit suite, the e2e groups, the budgets, docs, and the Safari capture before it is reported.
