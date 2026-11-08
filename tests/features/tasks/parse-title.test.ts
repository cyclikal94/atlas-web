import { describe, expect, test } from "vitest";
import {
  nextWeekday,
  parseTitle,
  stripTokens,
} from "../../../src/features/tasks/model/parse";

/** The create form's natural title (the Final design): what becomes a chip, and what never does. */
const TODAY = "2026-11-08"; // a Sunday

describe("parseTitle", () => {
  test("a weekday with a day number is that day of this month, or the next month that has it", () => {
    const parsed = parseTitle("Pay the water bill Fri 30", TODAY);
    expect(parsed.date).toBe("2026-11-30");
    expect(parsed.title).toBe("Pay the water bill");
    expect(parsed.tokens.map((t) => [t.kind, t.text])).toEqual([
      ["date", "Fri 30"],
    ]);
  });

  test("today, tomorrow and a bare weekday (today itself when it is that day)", () => {
    expect(parseTitle("Bins today", TODAY).date).toBe(TODAY);
    expect(parseTitle("Bins tomorrow", TODAY).date).toBe("2026-11-09");
    expect(parseTitle("Bins on Sunday", TODAY).date).toBe(TODAY);
    expect(parseTitle("Bins on Monday", TODAY)).toMatchObject({
      date: "2026-11-09",
      title: "Bins",
    });
  });

  test("a day with its month, either way round, and day/month", () => {
    expect(parseTitle("Dentist 3rd December", TODAY).date).toBe("2026-12-03");
    expect(parseTitle("Dentist Dec 3", TODAY).date).toBe("2026-12-03");
    expect(parseTitle("Dentist on 3/12", TODAY).date).toBe("2026-12-03");
    // A day that has passed this year is next year's.
    expect(parseTitle("Tax 31 Jan", TODAY).date).toBe("2027-01-31");
    // A day the month lacks is no date.
    expect(parseTitle("Leap 30 Feb", TODAY).date).toBeNull();
  });

  test("times: 24-hour, am/pm and 'at 6'", () => {
    expect(parseTitle("Call Nan at 18:30", TODAY)).toMatchObject({
      time: "18:30",
      title: "Call Nan",
    });
    expect(parseTitle("Call Nan 6pm", TODAY).time).toBe("18:00");
    expect(parseTitle("Call Nan at 6.30pm", TODAY).time).toBe("18:30");
    expect(parseTitle("Call Nan at 6", TODAY).time).toBe("06:00");
    expect(parseTitle("Call Nan at 12am", TODAY).time).toBe("00:00");
  });

  test("every day, every 2 weeks, daily, and every Monday (weekly from the next Monday)", () => {
    expect(parseTitle("Brush teeth every day", TODAY).repeat).toEqual({
      frequency: "daily",
      interval: 1,
    });
    expect(parseTitle("Clean the bathroom every 2 weeks", TODAY)).toMatchObject(
      {
        repeat: { frequency: "weekly", interval: 2 },
        title: "Clean the bathroom",
      },
    );
    expect(parseTitle("Stretch daily", TODAY).repeat).toEqual({
      frequency: "daily",
      interval: 1,
    });
    expect(parseTitle("Bins every Monday", TODAY)).toMatchObject({
      repeat: { frequency: "weekly", interval: 1 },
      date: "2026-11-09",
      title: "Bins",
    });
  });

  test("a bare number, a quantity and ordinary words are never chips", () => {
    for (const text of [
      "Read 20 pages",
      "Buy 6 eggs",
      "Monthly report review",
    ]) {
      const parsed = parseTitle(text, TODAY);
      expect(parsed.date, text).toBeNull();
      expect(parsed.time, text).toBeNull();
    }
    // "Monthly" alone is a cadence, as typed.
    expect(parseTitle("Monthly report review", TODAY).repeat).toEqual({
      frequency: "monthly",
      interval: 1,
    });
  });

  test("the first of a kind wins and the words leave the title cleanly", () => {
    const parsed = parseTitle(
      "Water the plants Fri 30 at 14:00, every week",
      TODAY,
    );
    expect(parsed).toMatchObject({
      date: "2026-11-30",
      time: "14:00",
      repeat: { frequency: "weekly", interval: 1 },
      title: "Water the plants",
    });
    expect(stripTokens("a  b", [])).toBe("a b");
  });

  test("nextWeekday", () => {
    expect(nextWeekday(TODAY, 6)).toBe(TODAY);
    expect(nextWeekday(TODAY, 0)).toBe("2026-11-09");
    expect(nextWeekday(TODAY, 5)).toBe("2026-11-14");
  });
});
