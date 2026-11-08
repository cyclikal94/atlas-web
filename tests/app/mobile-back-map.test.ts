// @vitest-environment node
import { describe, expect, test } from "vitest";
import { mobileBackFor } from "../../src/app/shell/mobile-back";

/** The phone's back affordance is derived from the address: every detail screen gets one, no top-level screen does. */
const TASK = "1b8a8ff1-21ad-43fa-a64c-3038d881884c";
const PERSON = "f508e13b-8d07-4600-a79e-2aba5869a297";

describe("mobileBackFor", () => {
  test("top-level screens keep the brand and the tabs", () => {
    for (const path of [
      "/today",
      "/upcoming",
      "/calendar",
      "/people",
      "/tasks",
      "/tasks/lists",
      "/sharing",
      "/settings",
      "/sync",
      "/",
    ])
      expect(mobileBackFor(path)).toBeUndefined();
  });

  test("task screens go back to Tasks, and a task's own pages to the task", () => {
    expect(mobileBackFor(`/tasks/${TASK}`)).toEqual({
      label: "Tasks",
      to: "/tasks",
    });
    expect(mobileBackFor("/tasks/new")).toEqual({
      label: "Tasks",
      to: "/tasks",
    });
    expect(mobileBackFor("/tasks/timers")).toEqual({
      label: "Tasks",
      to: "/tasks",
    });
    expect(mobileBackFor(`/tasks/${TASK}/edit`)).toEqual({
      label: "Task",
      to: `/tasks/${TASK}`,
    });
    expect(mobileBackFor(`/tasks/${TASK}/streak`)).toEqual({
      label: "Task",
      to: `/tasks/${TASK}`,
    });
    expect(mobileBackFor(`/tasks/lists/${TASK}`)).toEqual({
      label: "Lists",
      to: "/tasks/lists",
    });
  });

  test("people screens go back to People, and a person's own pages to the person", () => {
    expect(mobileBackFor(`/people/${PERSON}`)).toEqual({
      label: "People",
      to: "/people",
    });
    expect(mobileBackFor(`/people/${PERSON}/fields/new`)).toEqual({
      label: "Person",
      to: `/people/${PERSON}`,
    });
    expect(mobileBackFor(`/people/${PERSON}/fields/${TASK}`)).toEqual({
      label: "Person",
      to: `/people/${PERSON}`,
    });
    expect(mobileBackFor(`/people/${PERSON}/duplicates`)).toEqual({
      label: "Person",
      to: `/people/${PERSON}`,
    });
    expect(mobileBackFor(`/people/${PERSON}/duplicates/${TASK}`)).toEqual({
      label: "Person",
      to: `/people/${PERSON}`,
    });
    expect(mobileBackFor("/people/requests")).toEqual({
      label: "People",
      to: "/people",
    });
    expect(mobileBackFor("/people/requests/abc")).toEqual({
      label: "Requests",
      to: "/people/requests",
    });
    expect(mobileBackFor(`/people/merge/${PERSON}/${TASK}`)).toEqual({
      label: "People",
      to: "/people",
    });
  });

  test("sharing's editors go back to Sharing", () => {
    expect(mobileBackFor("/sharing/defaults")).toEqual({
      label: "Sharing",
      to: "/sharing",
    });
    expect(mobileBackFor(`/sharing/items/${TASK}`)).toEqual({
      label: "Sharing",
      to: "/sharing",
    });
  });
});
