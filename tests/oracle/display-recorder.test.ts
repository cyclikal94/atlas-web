// @vitest-environment node
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_LIMITS,
  EVIDENCE_COOKIE,
  oracleScript,
  type RecorderLimits,
  witnessScript,
} from "../e2e/display-recorder";

/**
 * WEB-08c revision 5 (R5-A of the review of 14 October 2026; design assessment P1, Q1, schedules S1-S7): the display recorder's
 * EVENT-TIME model on explicit histories, in a fresh jsdom document per case. Each schedule is made in ONE synchronous task, so the
 * recorder sees it only as a batch of mutation records whose nodes have since moved: what it judges must be what the document showed
 * at each record, not what the live tree shows afterwards. Native delivery in real engines is qualified separately
 * (`fixture.lifecycle-oracle.spec.ts`); these cases fix the semantics, not a browser's record stream.
 *
 * The `atlas-auth` boundary is driven through a minimal fake of the three IndexedDB prototypes the recorder wraps (transaction, getAll,
 * put): the test decides when a request succeeds and when the transaction completes or aborts.
 */
const MARKER = "oracle-marker-qualify";
const ACCOUNT = "acct-a";
const HTML = `<!doctype html><html><head><title>Atlas</title></head><body><div id="protected-root" inert aria-hidden="true"></div><button id="a">Safe</button><button id="b">Safe</button></body></html>`;
const FAKE_IDB = `
  window.IDBDatabase = class IDBDatabase { constructor(name) { this.name = name; } };
  window.IDBObjectStore = class IDBObjectStore {};
  window.IDBTransaction = class IDBTransaction extends EventTarget {};
  IDBDatabase.prototype.transaction = function (stores) {
    if (stores === "missing-store") throw new DOMException("No such store", "NotFoundError");
    const tx = new IDBTransaction();
    const store = new IDBObjectStore();
    store.transaction = tx;
    tx.objectStore = () => store;
    return tx;
  };
  IDBObjectStore.prototype.getAll = function () { const r = new EventTarget(); r.result = []; return r; };
  IDBObjectStore.prototype.put = function () { return new EventTarget(); };
`;

type Win = Window &
  typeof globalThis & {
    __displayOracle: {
      flush(): {
        violations: Array<{ kind: string; detail: string }>;
        limits: string[];
        sseq: number;
      };
      log: Array<Record<string, unknown>>;
      state(): { episode: string | null };
    };
    IDBDatabase: new (
      name: string,
    ) => {
      transaction(
        stores: string[],
        mode?: string,
      ): EventTarget & {
        objectStore(name: string): {
          put(value: unknown, key: string): unknown;
          getAll(): EventTarget & { result: unknown };
        };
      };
    };
    __displayOracleReport: (r: unknown) => void;
    __displayOracleWitness: (r: unknown) => void;
  };

/**
 * What a person's typing does (revision 6): the ENGINE fires a trusted `beforeinput`, changes the value without the script property, then
 * fires a trusted `input`. jsdom has no editing engine; its own internals do the same (the element's implementation, jsdom's event firing
 * with `isTrusted`). A script cannot make either: `dispatchEvent` events are untrusted.
 */
const jsdomInternals = createRequire(
  createRequire(import.meta.url).resolve("jsdom"),
);
const idl = jsdomInternals("./generated/idl/utils.js") as {
  implForWrapper(wrapper: unknown): Record<string, unknown>;
};
const events = jsdomInternals("./jsdom/living/helpers/events.js") as {
  fireAnEvent(
    type: string,
    target: unknown,
    eventInterface?: unknown,
    attributes?: Record<string, unknown>,
  ): boolean;
};
function typeInto(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  { beforeinput = true }: { beforeinput?: boolean } = {},
) {
  const impl = idl.implForWrapper(field);
  if (beforeinput)
    events.fireAnEvent("beforeinput", impl, undefined, {
      bubbles: true,
      cancelable: true,
    });
  impl.value = value;
  events.fireAnEvent("input", impl, undefined, { bubbles: true });
}

const state = (fenced: boolean) => ({
  settled: { account_id: ACCOUNT, epoch: 2 },
  fences: fenced ? { [ACCOUNT]: [{ epoch: 1 }] } : {},
});

function recorder(
  options: { markers?: string[]; limits?: Partial<RecorderLimits> } = {},
) {
  const dom = new JSDOM(HTML, {
    url: "https://atlas.test/today",
    runScripts: "outside-only",
  });
  const win = dom.window as unknown as Win;
  const reports: Array<Record<string, unknown>> = [];
  const witnessed: Array<Record<string, unknown>> = [];
  win.__displayOracleReport = (r) => {
    reports.push(r as Record<string, unknown>);
  };
  win.__displayOracleWitness = (r) => {
    witnessed.push(r as Record<string, unknown>);
  };
  win.eval(FAKE_IDB);
  win.eval(`(${witnessScript})(${JSON.stringify(EVIDENCE_COOKIE)})`);
  win.eval(
    `(${oracleScript})(${JSON.stringify({
      markers: options.markers ?? [MARKER],
      limits: { ...DEFAULT_LIMITS, ...options.limits },
    })})`,
  );
  const doc = win.document;
  const oracle = win.__displayOracle;
  const tx = () =>
    new win.IDBDatabase("atlas-auth").transaction(["records"], "readwrite");
  const flush = () => oracle.flush();
  return {
    win,
    doc,
    reports,
    witnessed,
    oracle,
    root: doc.getElementById("protected-root") as HTMLElement,
    kinds: () => flush().violations.map((v) => v.kind),
    details: () => flush().violations.map((v) => v.detail),
    limits: () => flush().limits,
    /** A committed auth_state write (fenced or clear). */
    commit(fenced: boolean) {
      const t = tx();
      t.objectStore("records").put(state(fenced), "auth_state");
      t.dispatchEvent(new win.Event("complete"));
    },
    abort(fenced: boolean) {
      const t = tx();
      t.objectStore("records").put(state(fenced), "auth_state");
      t.dispatchEvent(new win.Event("abort"));
    },
    /** A read whose request SUCCEEDS; the transaction completes only when `complete` is true. */
    read(fenced: boolean, complete: boolean) {
      const t = tx();
      const request = t.objectStore("records").getAll();
      request.result = [state(fenced)];
      request.dispatchEvent(new win.Event("success"));
      if (complete) t.dispatchEvent(new win.Event("complete"));
    },
  };
}

describe("S1: a subtree inserted and dismantled in one task is judged with the descendants it had when inserted", () => {
  for (const variant of ["text", "aria-label"] as const) {
    test(`nested ${variant}: outer inserted, inner removed by replaceChildren, outer removed (the review's probe)`, () => {
      const r = recorder();
      const outer = r.doc.createElement("div");
      const inner = r.doc.createElement("span");
      if (variant === "text") inner.textContent = MARKER;
      else inner.setAttribute("aria-label", MARKER);
      outer.append(inner);
      r.doc.body.append(outer);
      outer.replaceChildren();
      outer.remove();
      expect(r.doc.body.contains(outer)).toBe(false);
      expect(r.kinds()).toEqual(["marker"]);
      expect(r.limits()).toEqual([]);
    });
    test(`nested ${variant}: the same dismantled subtree with a safe value is clean (control)`, () => {
      const r = recorder();
      const outer = r.doc.createElement("div");
      const inner = r.doc.createElement("span");
      if (variant === "text") inner.textContent = "Safe";
      else inner.setAttribute("aria-label", "Safe");
      outer.append(inner);
      r.doc.body.append(outer);
      outer.replaceChildren();
      outer.remove();
      expect(r.kinds()).toEqual([]);
      expect(r.limits()).toEqual([]);
    });
  }
  test("controls: a direct append/remove and an intact nested removal are each detected", () => {
    const r = recorder();
    const direct = r.doc.createElement("p");
    direct.textContent = MARKER;
    r.doc.body.append(direct);
    direct.remove();
    expect(r.kinds()).toEqual(["marker"]);
    const outer = r.doc.createElement("div");
    outer.append(r.doc.createElement("span"));
    (outer.firstChild as HTMLElement).textContent = MARKER;
    r.doc.body.append(outer);
    outer.remove();
    expect(r.kinds()).toEqual(["marker", "marker"]);
  });
});

describe("S2: topology variants", () => {
  const cases: Record<string, (d: Document) => void> = {
    "siblings removed first-to-last": (d) => {
      const outer = d.createElement("div");
      const a = d.createElement("span");
      const b = d.createElement("span");
      b.textContent = MARKER;
      outer.append(a, b);
      d.body.append(outer);
      a.remove();
      b.remove();
      outer.remove();
    },
    "siblings removed last-to-first": (d) => {
      const outer = d.createElement("div");
      const a = d.createElement("span");
      const b = d.createElement("span");
      a.textContent = MARKER;
      outer.append(a, b);
      d.body.append(outer);
      b.remove();
      a.remove();
      outer.remove();
    },
    "inner moved to another connected parent, then removed": (d) => {
      const one = d.createElement("div");
      const two = d.createElement("div");
      const inner = d.createElement("span");
      inner.setAttribute("aria-label", MARKER);
      one.append(inner);
      d.body.append(one, two);
      two.append(inner);
      inner.remove();
      one.remove();
      two.remove();
    },
    "a containing subtree replaced": (d) => {
      const holder = d.createElement("section");
      d.body.append(holder);
      const outer = d.createElement("div");
      outer.innerHTML = `<p><em>${MARKER}</em></p>`;
      holder.append(outer);
      holder.replaceWith(d.createElement("section"));
    },
    "inserted from a fragment and removed": (d) => {
      const fragment = d.createDocumentFragment();
      const p = d.createElement("p");
      p.textContent = MARKER;
      fragment.append(d.createElement("i"), p);
      d.body.append(fragment);
      p.remove();
    },
  };
  // A node MOVED within the document is inserted again: a second exposure event, reported again (no node-lifetime deduplication).
  const expected: Record<string, number> = {
    "inner moved to another connected parent, then removed": 2,
  };
  for (const [name, schedule] of Object.entries(cases))
    test(`${name}: reported for each insertion that showed it`, () => {
      const r = recorder();
      schedule(r.doc);
      expect(r.kinds()).toEqual(
        Array.from({ length: expected[name] ?? 1 }, () => "marker"),
      );
      expect(r.limits()).toEqual([]);
    });
  // "Ancestor removed, then a descendant edited" needs the TRANSIENT observers the DOM standard gives a removed subtree (records of
  // edits inside it until delivery); jsdom does not implement them, so that schedule is qualified natively only
  // (`fixture.lifecycle-oracle.spec.ts`, S2).
  test("a subtree built and dismantled while DETACHED is never exposed (control)", () => {
    const r = recorder();
    const outer = r.doc.createElement("div");
    const inner = r.doc.createElement("span");
    inner.textContent = MARKER;
    outer.append(inner);
    outer.replaceChildren();
    const holder = r.doc.createElement("div");
    holder.append(outer);
    r.doc.body.append(holder);
    holder.remove();
    expect(r.kinds()).toEqual([]);
    expect(r.limits()).toEqual([]);
  });
  test("a marker written only while detached, then made safe before insertion, is clean (control)", () => {
    const r = recorder();
    const node = r.doc.createElement("p");
    r.doc.body.append(node);
    node.remove();
    // The removal is delivered: the node is outside the document and its later edits are not observed.
    r.oracle.flush();
    node.textContent = MARKER;
    node.textContent = "safe";
    r.doc.body.append(node);
    node.remove();
    expect(r.kinds()).toEqual([]);
  });
  test("a safe move between parents is clean (control)", () => {
    const r = recorder();
    const one = r.doc.createElement("div");
    const two = r.doc.createElement("div");
    const inner = r.doc.createElement("span");
    inner.textContent = "safe";
    one.append(inner);
    r.doc.body.append(one, two);
    two.append(inner);
    expect(r.kinds()).toEqual([]);
    expect(r.limits()).toEqual([]);
  });
});

describe("S3: title text is judged under the title membership it had at each record", () => {
  test("a marker-free protected title inserted, changed to Atlas and detached (the review's refined probe) is a title violation", () => {
    const r = recorder({ markers: [MARKER] });
    const title = r.doc.querySelector("title") as HTMLTitleElement;
    const text = r.doc.createTextNode("Protected task details");
    title.replaceChildren(text);
    text.data = "Atlas";
    text.remove();
    expect(r.doc.title).toBe("");
    expect(r.kinds()).toEqual(["title"]);
  });
  test("variant: the TITLE element itself replaced by one carrying the protected text, then by a neutral one", () => {
    const r = recorder();
    const old = r.doc.querySelector("title") as HTMLTitleElement;
    const protectedTitle = r.doc.createElement("title");
    protectedTitle.textContent = "Today · Atlas";
    old.replaceWith(protectedTitle);
    const neutral = r.doc.createElement("title");
    neutral.textContent = "Atlas";
    protectedTitle.replaceWith(neutral);
    expect(r.kinds()).toEqual(["title"]);
  });
  test("variant: the title's text node moved out of the title, given a protected title while OUTSIDE it (ordinary text then), moved back, made neutral", () => {
    const r = recorder();
    const title = r.doc.querySelector("title") as HTMLTitleElement;
    const text = title.firstChild as Text;
    const parking = r.doc.createElement("div");
    r.doc.head.append(parking);
    parking.append(text);
    text.data = "Today · Atlas";
    title.append(text);
    text.data = "Atlas";
    parking.remove();
    // One title violation: when the text came BACK into the title; while outside it, it was ordinary text without a marker.
    expect(r.kinds()).toEqual(["title"]);
    expect(r.details()[0]).toContain("title children changed");
  });
  test("controls: a neutral title write is clean; the setter's protected value is detected once", () => {
    const r = recorder();
    r.doc.title = "Atlas";
    expect(r.kinds()).toEqual([]);
    r.doc.title = "Protected task details";
    r.doc.title = "Atlas";
    expect(r.kinds()).toEqual(["title"]);
    const setter = r.oracle.log.filter((e) => e.op === "title.setter");
    expect(setter.map((e) => e.suppressed)).toEqual([1, 1, 1]);
  });
  test("the setter's own records are still replayed: a marker inserted in the SAME batch as a title write is judged", () => {
    const r = recorder();
    const p = r.doc.createElement("p");
    p.textContent = MARKER;
    r.doc.body.append(p);
    r.doc.title = "Atlas";
    p.remove();
    expect(r.kinds()).toEqual(["marker"]);
  });
});

describe("S4: existing nodes' text and names, per target, with event-time id references", () => {
  test("persistent accessible name, text set and reset, textContent replaced, per-target interleaving", () => {
    const r = recorder();
    const a = r.doc.getElementById("a") as HTMLElement;
    const b = r.doc.getElementById("b") as HTMLElement;
    a.setAttribute("aria-label", MARKER);
    expect(r.kinds()).toEqual(["marker"]);
    (b.firstChild as Text).data = MARKER;
    (b.firstChild as Text).data = "Safe";
    expect(r.kinds()).toHaveLength(2);
    b.textContent = MARKER;
    b.textContent = "Safe";
    expect(r.kinds()).toHaveLength(3);
    a.setAttribute("aria-label", "x");
    b.setAttribute("aria-label", MARKER);
    a.setAttribute("aria-label", "y");
    expect(r.kinds()).toHaveLength(4);
  });
  test("a reference resolved at the moment it is set: the referent removed in the same task is still the name", () => {
    const r = recorder();
    // The referent exists, with the account's text, while the account is authorised and displayed (its episode open).
    r.commit(false);
    r.root.removeAttribute("inert");
    const label = r.doc.createElement("span");
    label.id = "lbl";
    label.textContent = MARKER;
    r.doc.body.append(label);
    r.oracle.flush();
    expect(r.oracle.state().episode).toBe(ACCOUNT);
    r.root.setAttribute("inert", "");
    r.oracle.flush();
    expect(r.oracle.state().episode).toBe(null);
    // Gated: a control points its name at the referent, which is then removed in the same task.
    const a = r.doc.getElementById("a") as HTMLElement;
    a.setAttribute("aria-labelledby", "lbl");
    label.remove();
    a.removeAttribute("aria-labelledby");
    expect(r.kinds()).toEqual(["marker"]);
  });
  test("control: a reference set after its referent was removed names nothing", () => {
    const r = recorder();
    r.commit(false);
    r.root.removeAttribute("inert");
    const label = r.doc.createElement("span");
    label.id = "lbl";
    label.textContent = MARKER;
    r.doc.body.append(label);
    r.root.setAttribute("inert", "");
    r.oracle.flush();
    label.remove();
    (r.doc.getElementById("a") as HTMLElement).setAttribute(
      "aria-labelledby",
      "lbl",
    );
    expect(r.kinds()).toEqual([]);
  });
});

describe("S5: the protected root, episodes and replacement", () => {
  test("mount, lift and regate in one task while fenced: each reported", () => {
    const r = recorder();
    r.commit(true);
    const node = r.doc.createElement("div");
    r.root.append(node);
    node.remove();
    r.root.removeAttribute("inert");
    r.root.setAttribute("inert", "");
    r.root.setAttribute("aria-hidden", "false");
    r.root.setAttribute("aria-hidden", "true");
    expect(r.kinds()).toEqual(["mount", "lift", "lift"]);
  });
  test("an authorised tree's gate and unmount are clean; a later fenced remount of the SAME node is still reported", () => {
    const r = recorder();
    r.commit(false);
    const tree = r.doc.createElement("div");
    tree.textContent = MARKER;
    r.root.append(tree);
    r.root.removeAttribute("inert");
    r.root.setAttribute("inert", "");
    tree.remove();
    expect(r.kinds()).toEqual([]);
    r.commit(true);
    r.root.append(tree);
    tree.remove();
    expect(r.kinds()).toEqual(["mount", "marker"]);
  });
  test("an ungated element that becomes #protected-root (a replacement) is reported as a lift", () => {
    const r = recorder();
    r.commit(true);
    const replacement = r.doc.createElement("div");
    replacement.id = "protected-root";
    r.root.replaceWith(replacement);
    replacement.setAttribute("inert", "");
    replacement.setAttribute("aria-hidden", "true");
    expect(r.kinds()).toEqual(["lift"]);
  });
  test("control: a gated replacement root with no content is clean", () => {
    const r = recorder();
    r.commit(true);
    const replacement = r.doc.createElement("div");
    replacement.id = "protected-root";
    replacement.setAttribute("inert", "");
    replacement.setAttribute("aria-hidden", "true");
    r.root.replaceWith(replacement);
    expect(r.kinds()).toEqual([]);
    expect(r.limits()).toEqual([]);
  });
});

describe("S6: form fields in event order", () => {
  const field = (r: ReturnType<typeof recorder>) => {
    const input = r.doc.createElement("input");
    input.id = "f";
    input.addEventListener("input", () =>
      input.setAttribute("value", input.value),
    );
    r.doc.body.append(input);
    r.oracle.flush();
    return input;
  };
  const type = (_r: ReturnType<typeof recorder>, input: HTMLInputElement) =>
    typeInto(input, MARKER);
  test("typed then mirrored into the value attribute: clean (HF-14)", () => {
    const r = recorder();
    const input = field(r);
    type(r, input);
    expect(input.getAttribute("value")).toBe(MARKER);
    expect(r.kinds()).toEqual([]);
  });
  test("an application prefill BEFORE the person types the same value is still reported (no retroactive exemption)", () => {
    const r = recorder();
    const input = field(r);
    input.setAttribute("value", MARKER);
    type(r, input);
    expect(r.kinds()).toEqual(["marker"]);
  });
  test("a prefill of a DIFFERENT field than the one typed into is reported", () => {
    const r = recorder();
    const input = field(r);
    type(r, input);
    const other = r.doc.createElement("input");
    r.doc.body.append(other);
    other.setAttribute("value", MARKER);
    expect(r.kinds()).toEqual(["marker"]);
  });
  test("the value PROPERTY written by the page is judged; the same value after the person typed it is not", () => {
    const r = recorder();
    const plain = r.doc.createElement("input");
    r.doc.body.append(plain);
    plain.value = MARKER;
    expect(r.kinds()).toEqual(["marker"]);
    const typed = field(r);
    type(r, typed);
    typed.value = MARKER;
    expect(r.kinds()).toEqual(["marker"]);
  });
});

describe("D1-D5 (revision 6, R5-A): a field's property-only value is judged when the field becomes visible", () => {
  type Field = HTMLInputElement | HTMLTextAreaElement;
  const make = (r: ReturnType<typeof recorder>, tag: "input" | "textarea") =>
    r.doc.createElement(tag) as Field;
  for (const tag of ["input", "textarea"] as const) {
    test(`D1 ${tag}: prefilled while detached, then inserted (the review's probe): reported`, () => {
      const r = recorder();
      const field = make(r, tag);
      field.value = MARKER;
      expect(r.kinds(), "nothing is exposed while detached").toEqual([]);
      r.doc.body.append(field);
      expect(field.getAttribute("value")).toBe(null);
      expect(r.kinds()).toEqual(["marker"]);
    });
    test(`D1 ${tag}: a safe detached prefill, inserted, is clean (control)`, () => {
      const r = recorder();
      const field = make(r, tag);
      field.value = "Safe input";
      r.doc.body.append(field);
      expect(r.kinds()).toEqual([]);
      expect(r.limits()).toEqual([]);
    });
    test(`D2 ${tag}: prefilled inside a container, inserted, then the container dismantled in the same task: reported once`, () => {
      const r = recorder();
      const outer = r.doc.createElement("div");
      const field = make(r, tag);
      field.value = MARKER;
      outer.append(field);
      r.doc.body.append(outer);
      outer.replaceChildren();
      outer.remove();
      expect(r.kinds()).toEqual(["marker"]);
    });
    test(`D2 ${tag}: prefilled in a fragment, inserted, then reparented within the document: one report per insertion`, () => {
      const r = recorder();
      const fragment = r.doc.createDocumentFragment();
      const field = make(r, tag);
      field.value = MARKER;
      fragment.append(field);
      const holder = r.doc.createElement("div");
      r.doc.body.append(fragment, holder);
      holder.append(field);
      field.remove();
      holder.remove();
      expect(r.kinds()).toEqual(["marker", "marker"]);
    });
    test(`D2 ${tag}: a marker written while detached and made safe BEFORE insertion is clean (control)`, () => {
      const r = recorder();
      const outer = r.doc.createElement("div");
      const field = make(r, tag);
      field.value = MARKER;
      outer.append(field);
      field.value = "Safe";
      r.doc.body.append(outer);
      outer.remove();
      expect(r.kinds()).toEqual([]);
    });
    test(`D3 ${tag}: inserted prefilled, then made safe in the same task: the earlier exposure stands`, () => {
      const r = recorder();
      const field = make(r, tag);
      field.value = MARKER;
      r.doc.body.append(field);
      field.value = "";
      field.remove();
      expect(r.kinds()).toEqual(["marker"]);
    });
    // The reset BUTTON of a detached form is native-only: jsdom does not run a detached button's activation behaviour.
    test(`D3 ${tag}: inserted in a form, removed, then the DETACHED form reset programmatically: reported`, () => {
      for (const how of ["reset()"]) {
        const r = recorder();
        const form = r.doc.createElement("form");
        const field = make(r, tag);
        const button = r.doc.createElement("button");
        button.type = "reset";
        form.append(field, button);
        field.value = MARKER;
        r.doc.body.append(form);
        form.remove();
        form.reset();
        expect(field.value, how).toBe("");
        expect(r.kinds(), how).toEqual(["marker"]);
      }
    });
    test(`D3 ${tag}: setRangeText while detached, then inserted: reported; connected safe → marker → safe through setRangeText: reported`, () => {
      const r = recorder();
      const field = make(r, tag);
      field.setRangeText(MARKER);
      r.doc.body.append(field);
      expect(r.kinds()).toEqual(["marker"]);
      const k = recorder();
      const connected = make(k, tag);
      k.doc.body.append(connected);
      connected.value = "safe";
      connected.setRangeText(MARKER, 0, 4);
      connected.setRangeText("safe", 0, MARKER.length);
      expect(k.kinds()).toEqual(["marker"]);
    });
    test(`D3 ${tag}: a default value (attribute or text) with the marker is reported ONCE, by its record`, () => {
      const r = recorder();
      const field = make(r, tag);
      field.defaultValue = MARKER;
      r.doc.body.append(field);
      expect(field.value).toBe(MARKER);
      expect(r.kinds()).toEqual(["marker"]);
    });
    test(`D3 ${tag}: a connected form reset by its event while the field holds a safe value is clean; a cancelled reset changes nothing (controls)`, () => {
      const r = recorder();
      const form = r.doc.createElement("form");
      const field = make(r, tag);
      form.append(field);
      r.doc.body.append(form);
      field.value = "safe";
      form.addEventListener("reset", (e) => e.preventDefault(), { once: true });
      form.reset();
      expect(field.value).toBe("safe");
      form.reset();
      expect(field.value).toBe("");
      expect(r.kinds()).toEqual([]);
    });
    test(`D4 ${tag}: a prefilled field COPIED by cloneNode / importNode, the copy inserted: reported; a safe copy is clean`, () => {
      for (const how of ["clone", "import", "adopt"]) {
        const r = recorder();
        const source =
          how === "clone"
            ? r.doc
            : r.doc.implementation.createHTMLDocument("x");
        const original = source.createElement(tag) as Field;
        original.value = MARKER;
        const copy =
          how === "clone"
            ? (original.cloneNode(true) as Field)
            : how === "import"
              ? (r.doc.importNode(original, true) as Field)
              : original;
        expect(copy.value, how).toBe(MARKER);
        r.doc.body.append(copy);
        expect(r.kinds(), how).toEqual(["marker"]);
        const safe = r.doc.createElement(tag) as Field;
        safe.value = "Safe";
        r.doc.body.append(safe.cloneNode(true));
        expect(r.kinds(), `${how} control`).toEqual(["marker"]);
      }
    });
  }
  test("D4: a password field holding the marker is concealed; its type made text reveals it: reported at the type change", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    field.type = "password";
    field.value = MARKER;
    r.doc.body.append(field);
    expect(r.kinds(), "concealed").toEqual([]);
    field.type = "text";
    field.type = "password";
    expect(r.kinds()).toEqual(["marker"]);
    expect(r.details()[0]).toContain("type password → text");
  });
  test("D4: a hidden field's value IS its attribute (judged as such, once); revealing it adds no second report (the review's control)", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    field.type = "hidden";
    r.doc.body.append(field);
    field.value = MARKER;
    field.type = "text";
    expect(r.kinds()).toEqual(["marker"]);
  });
  // "Inserted as password, removed, made text while detached" is native-only: the type record of a just-removed field comes from a
  // transient registered observer, which jsdom does not implement (it would judge the insertion with the later type: an over-report).
  test("D5: what the person typed, moved with its field, stays theirs; an application rewrite ends the exemption", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    r.doc.body.append(field);
    typeInto(field, MARKER);
    field.value = MARKER;
    field.setAttribute("value", MARKER);
    const holder = r.doc.createElement("div");
    r.doc.body.append(holder);
    holder.append(field);
    expect(r.kinds(), "the person's own entry").toEqual([]);
    field.value = "";
    field.value = MARKER;
    expect(r.kinds(), "rewritten by the application").toEqual(["marker"]);
  });
  test("D5: a script-dispatched input event is not the person's: a detached prefill it 'confirms' is still reported on insertion", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    field.value = MARKER;
    field.dispatchEvent(new r.win.Event("input", { bubbles: true }));
    r.doc.body.append(field);
    expect(r.kinds()).toEqual(["marker"]);
  });
  test("D5: a dispatched input event before a password field is revealed gives no exemption; a trusted edit does (control)", () => {
    for (const trusted of [false, true]) {
      const r = recorder();
      const field = r.doc.createElement("input");
      field.type = "password";
      r.doc.body.append(field);
      r.oracle.flush();
      if (trusted) typeInto(field, MARKER);
      else {
        field.value = MARKER;
        field.dispatchEvent(new r.win.Event("input", { bubbles: true }));
      }
      field.type = "text";
      expect(r.kinds(), trusted ? "typed" : "dispatched").toEqual(
        trusted ? [] : ["marker"],
      );
    }
  });
  test("D5: a trusted edit with no beforeinput in the very task that inserted its field is incomplete (its value at insertion is unknown)", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    r.doc.body.append(field);
    typeInto(field, "typed", { beforeinput: false });
    expect(r.limits()).toEqual([
      "a field was edited with no beforeinput in the task that inserted it (its value at insertion is unknown)",
    ]);
    const k = recorder();
    const settled = k.doc.createElement("input");
    k.doc.body.append(settled);
    k.oracle.flush();
    typeInto(settled, "typed", { beforeinput: false });
    expect(k.limits(), "control: the insertion was judged earlier").toEqual([]);
  });
  test("D5: the person's entry gives no exemption to another field", () => {
    const r = recorder();
    const a = r.doc.createElement("input");
    const b = r.doc.createElement("input");
    r.doc.body.append(a);
    typeInto(a, MARKER);
    b.value = MARKER;
    r.doc.body.append(b);
    expect(r.kinds()).toEqual(["marker"]);
  });
});

describe("S7: authority only from this document's COMPLETED transaction, with earlier DOM judged first", () => {
  test("a fence-clearing write that aborts authorises nothing", () => {
    const r = recorder();
    r.commit(true);
    r.abort(false);
    r.root.removeAttribute("inert");
    r.root.setAttribute("inert", "");
    expect(r.kinds()).toEqual(["lift"]);
  });
  test("a read whose request succeeded but whose transaction has not completed authorises nothing", () => {
    const r = recorder();
    r.commit(true);
    r.read(false, false);
    r.root.removeAttribute("inert");
    r.root.setAttribute("inert", "");
    expect(r.kinds()).toEqual(["lift"]);
  });
  test("a lift made BEFORE the completing transaction, in the same task, is judged under the fenced record", () => {
    const r = recorder();
    r.commit(true);
    r.root.removeAttribute("inert");
    r.read(false, true);
    expect(r.kinds()).toEqual(["lift"]);
  });
  test("control: a lift after the clearing transaction completes is authorised and opens the episode", () => {
    const r = recorder();
    r.commit(true);
    r.read(false, true);
    r.root.removeAttribute("inert");
    expect(r.kinds()).toEqual([]);
    expect(r.oracle.state().episode).toBe(ACCOUNT);
  });
});

describe("Bounds and unobserved routes are incomplete, never clean", () => {
  test("a subtree over the walk limit", () => {
    const r = recorder({ limits: { subtree: 5 } });
    const outer = r.doc.createElement("div");
    for (let i = 0; i < 10; i += 1) outer.append(r.doc.createElement("i"));
    r.doc.body.append(outer);
    expect(r.limits()).toEqual(["subtree over 5 nodes"]);
  });
  test("a log over its limit", () => {
    const r = recorder({ limits: { log: 3 } });
    for (let i = 0; i < 5; i += 1) r.doc.title = "Atlas";
    expect(r.limits()).toEqual(["log over 3 entries"]);
  });
  test("a batch over the record limit", () => {
    const r = recorder({ limits: { records: 3 } });
    for (let i = 0; i < 5; i += 1) r.doc.body.append(r.doc.createElement("i"));
    expect(r.limits()).toEqual(["batch over 3 records"]);
  });
  test("a shadow root", () => {
    const r = recorder();
    r.doc.createElement("div").attachShadow({ mode: "open" });
    expect(r.limits()).toEqual([
      "a shadow root was attached (its content is not observed)",
    ]);
  });
  test("each limit is a substantive report the witness counts", () => {
    const r = recorder({ limits: { subtree: 2 } });
    const outer = r.doc.createElement("div");
    outer.append(r.doc.createElement("i"), r.doc.createElement("i"));
    r.doc.body.append(outer);
    const flushed = r.oracle.flush();
    expect(flushed.sseq).toBe(2);
    expect(r.reports.map((x) => [x.type, x.sseq])).toEqual([
      ["enrolled", 1],
      ["incomplete", 2],
    ]);
    expect(r.doc.cookie).toBe("");
  });
});

describe("S16: the instrumentation keeps the product's own behaviour", () => {
  test("a failing transaction() throws the same error through the wrapper; another document's title and a detached field pass through", () => {
    const r = recorder();
    const db = new r.win.IDBDatabase("atlas-auth");
    let thrown: unknown = null;
    try {
      db.transaction("missing-store" as unknown as string[]);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DOMException).name).toBe("NotFoundError");
    const other = r.doc.implementation.createHTMLDocument("Atlas");
    other.title = "Protected task details";
    expect(other.title).toBe("Protected task details");
    const detached = r.doc.createElement("input");
    detached.value = MARKER;
    expect(detached.value).toBe(MARKER);
    expect(r.kinds()).toEqual([]);
    expect(r.limits()).toEqual([]);
  });
});

describe("Identity and terminal counters", () => {
  test("the recorder takes the witness's identity; the witness counts enrolment and every substantive report", () => {
    const r = recorder();
    const doc = r.witnessed[0]?.doc;
    expect(r.witnessed[0]).toMatchObject({ type: "document", role: "main" });
    expect(r.reports[0]).toMatchObject({ type: "enrolled", doc, sseq: 1 });
    const p = r.doc.createElement("p");
    p.textContent = MARKER;
    r.doc.body.append(p);
    r.oracle.flush();
    expect(r.reports.at(-1)).toMatchObject({
      type: "violation",
      doc,
      sseq: 2,
    });
  });
});
