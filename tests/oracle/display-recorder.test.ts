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
    // Revision 8 adaptation (labelled): the insertion is made through jsdom's own implementation (an UNORDERED structural route, as a
    // window with no recorder would make it), because an ordered `append` is now judged when it returns (see the next case).
    (
      idl.implForWrapper(r.doc.body) as unknown as {
        appendChild(node: unknown): unknown;
      }
    ).appendChild(idl.implForWrapper(field));
    expect(field.isConnected).toBe(true);
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
  test("D5 (revision 8): an insertion through an ORDERED route is judged when it returns, so the same edit leaves nothing unknown", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    field.value = MARKER;
    r.doc.body.append(field);
    typeInto(field, "typed", { beforeinput: false });
    expect(r.kinds(), "judged with the value it had at insertion").toEqual([
      "marker",
    ]);
    expect(r.limits()).toEqual([]);
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

/**
 * WEB-08c revision 7 (review 7 R5-A of 15 October 2026; design assessment P1-P3, Q1, T1-T3/R1-R4/X1/U1-U2): the model of the two missing
 * boundaries. A native TYPE change (any of its routes) can erase a value an insertion had already shown, without the value setter; and a
 * field ADOPTED from another window keeps that window's prototypes. Separate jsdom windows are separate realms (their own interfaces and
 * prototypes; `instanceof` the other's is false), which is what these cases need: a same-realm detached document is not one. Native
 * delivery, conversion and adoption in Chromium, Firefox and WebKit are qualified in `fixture.lifecycle-oracle.spec.ts`.
 */
type Field = HTMLInputElement | HTMLTextAreaElement;
/** A same-origin window with (instrumented) or without the witness and recorder. */
function donorWindow(instrumented: boolean) {
  const dom = new JSDOM(HTML, {
    url: "https://atlas.test/blank",
    runScripts: "outside-only",
  });
  const win = dom.window as unknown as Win & { close(): void };
  const reports: Array<Record<string, unknown>> = [];
  win.__displayOracleReport = (r) => {
    reports.push(r as Record<string, unknown>);
  };
  win.__displayOracleWitness = () => undefined;
  if (instrumented) {
    win.eval(FAKE_IDB);
    win.eval(`(${witnessScript})(${JSON.stringify(EVIDENCE_COOKIE)})`);
    win.eval(
      `(${oracleScript})(${JSON.stringify({ markers: [MARKER], limits: DEFAULT_LIMITS })})`,
    );
  }
  return { win, doc: win.document, reports };
}
const sanitising = () => {
  const probe = donorWindow(false).doc.createElement("input");
  probe.value = "abc";
  probe.type = "number";
  return probe.value === "";
};

describe("R7 T1-T3: a native type change is ordered before it erases the value an insertion showed", () => {
  test("precondition: jsdom sanitises the value when the type becomes number (as Chromium, Firefox and WebKit do)", () => {
    expect(sanitising()).toBe(true);
  });
  const ROUTES: Record<string, (f: HTMLInputElement, doc: Document) => void> = {
    "type property (number)": (f) => {
      f.type = "number";
    },
    "type property (file)": (f) => {
      f.type = "file";
    },
    setAttribute: (f) => f.setAttribute("type", "number"),
    "setAttributeNS(null)": (f) => f.setAttributeNS(null, "type", "number"),
    "attribute node value": (f) => {
      (f.getAttributeNode("type") as Attr).value = "number";
    },
    "attribute node nodeValue": (f) => {
      (f.getAttributeNode("type") as Attr).nodeValue = "number";
    },
    "attribute node textContent": (f) => {
      (f.getAttributeNode("type") as Attr).textContent = "number";
    },
    setAttributeNode: (f, doc) => {
      const attr = doc.createAttribute("type");
      attr.value = "number";
      f.setAttributeNode(attr);
    },
    "NamedNodeMap setNamedItem": (f, doc) => {
      const attr = doc.createAttribute("type");
      attr.value = "number";
      f.attributes.setNamedItem(attr);
    },
  };
  for (const [route, change] of Object.entries(ROUTES)) {
    test(`T1/T2 ${route}: inserted with the marker, then the type erases it in the same task: reported`, () => {
      const r = recorder();
      const field = r.doc.createElement("input");
      field.setAttribute("type", "text");
      field.value = MARKER;
      r.doc.body.append(field);
      change(field, r.doc);
      expect(field.value, "the native side effect happened").toBe("");
      expect(r.kinds()).toEqual(["marker"]);
      expect(r.limits()).toEqual([]);
    });
    test(`T1/T2 ${route}: made safe while DETACHED, inserted, then the type changed: clean (control)`, () => {
      const r = recorder();
      const field = r.doc.createElement("input");
      field.setAttribute("type", "text");
      field.value = MARKER;
      field.value = "Safe";
      r.doc.body.append(field);
      change(field, r.doc);
      expect(r.kinds()).toEqual([]);
      expect(r.limits()).toEqual([]);
    });
  }
  test("T1 controls: the marker kept is reported; cleared through the value setter is reported once", () => {
    for (const clear of [false, true]) {
      const r = recorder();
      const field = r.doc.createElement("input");
      field.value = MARKER;
      r.doc.body.append(field);
      if (clear) field.value = "";
      expect(r.kinds(), clear ? "cleared" : "kept").toEqual(["marker"]);
    }
  });
  const REVEAL: Record<string, (f: HTMLInputElement, doc: Document) => void> = {
    removeAttribute: (f) => f.removeAttribute("type"),
    "removeAttributeNS(null)": (f) => f.removeAttributeNS(null, "type"),
    toggleAttribute: (f) => {
      f.toggleAttribute("type");
    },
    removeAttributeNode: (f) => {
      f.removeAttributeNode(f.getAttributeNode("type") as Attr);
    },
    "NamedNodeMap removeNamedItem": (f) => {
      f.attributes.removeNamedItem("type");
    },
    "NamedNodeMap removeNamedItemNS": (f) => {
      f.attributes.removeNamedItemNS(null, "type");
    },
  };
  for (const [route, reveal] of Object.entries(REVEAL))
    test(`T2 ${route}: a password field's marker revealed by removing its type is reported; still concealed it is clean`, () => {
      const r = recorder();
      const field = r.doc.createElement("input");
      field.setAttribute("type", "password");
      field.value = MARKER;
      r.doc.body.append(field);
      expect(r.kinds(), "concealed").toEqual([]);
      reveal(field, r.doc);
      expect(field.type).toBe("text");
      expect(r.kinds()).toEqual(["marker"]);
    });
  test("T2 lookalike: a NAMESPACED `type` attribute neither conceals nor reveals (the field's type is the null-namespace attribute)", () => {
    const r = recorder();
    const shown = r.doc.createElement("input");
    shown.setAttributeNS("urn:x", "type", "password");
    shown.value = MARKER;
    r.doc.body.append(shown);
    expect(shown.type).toBe("text");
    expect(r.kinds(), "a text field with a lookalike is shown").toEqual([
      "marker",
    ]);
    const k = recorder();
    const hidden = k.doc.createElement("input");
    hidden.type = "password";
    hidden.value = MARKER;
    k.doc.body.append(hidden);
    hidden.setAttributeNS("urn:x", "type", "text");
    expect(hidden.type).toBe("password");
    expect(k.kinds(), "a lookalike does not reveal").toEqual([]);
  });
  test("T3 a container inserted with the field, dismantled, then the type changed: the insertion stands", () => {
    const r = recorder();
    const outer = r.doc.createElement("div");
    const field = r.doc.createElement("input");
    field.value = MARKER;
    outer.append(field);
    r.doc.body.append(outer);
    outer.replaceChildren();
    field.type = "number";
    outer.remove();
    expect(r.kinds()).toEqual(["marker"]);
  });
  test("T3 never exposed: a field changed and sanitised while detached, inserted afterwards, is clean (control)", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    field.value = MARKER;
    field.type = "number";
    r.doc.body.append(field);
    expect(r.kinds()).toEqual([]);
    expect(r.limits()).toEqual([]);
  });
});

describe("R7 U1-U2: unknown values are incomplete; the instrumentation converts each argument once and keeps native errors", () => {
  test("U1 an UNORDERED change (no route the recorder orders) that decides the verdict is incomplete, never clean", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    field.value = "Safe";
    r.doc.body.append(field);
    // The engine changes the value with no script route and no event (as autofill or a restoration could).
    idl.implForWrapper(field).value = MARKER;
    expect(r.kinds()).toEqual([]);
    expect(r.limits()).toEqual([
      "a field's value was changed by a route that is not ordered (its value at a record is unknown)",
    ]);
  });
  test("U1 control: an unordered change between two safe values decides nothing (clean, complete)", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    field.value = "Safe";
    r.doc.body.append(field);
    idl.implForWrapper(field).value = "Also safe";
    expect(r.kinds()).toEqual([]);
    expect(r.limits()).toEqual([]);
  });
  test("U2 argument conversion runs exactly once per argument, in order, for every converting route", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    r.doc.body.append(field);
    const calls: string[] = [];
    const as = (text: string) => ({
      toString() {
        calls.push(text);
        return text;
      },
    });
    field.type = as("search") as unknown as string;
    field.setAttribute(
      as("min") as unknown as string,
      as("1") as unknown as string,
    );
    field.setAttributeNS(
      as("") as unknown as string,
      as("max") as unknown as string,
      as("9") as unknown as string,
    );
    field.value = as("v") as unknown as string;
    field.defaultValue = as("d") as unknown as string;
    (field.getAttributeNode("min") as Attr).value = as(
      "2",
    ) as unknown as string;
    expect(calls).toEqual([
      "search",
      "min",
      "1",
      "",
      "max",
      "9",
      "v",
      "d",
      "2",
    ]);
    expect([field.type, field.min, field.max, field.value]).toEqual([
      "search",
      "2",
      "9",
      "v",
    ]);
  });
  test("U2 native errors are the engine's: a missing argument converts nothing; a symbol is a TypeError; a wrong receiver is refused", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    /** The error's name (the jsdom window's own TypeError is not this realm's). */
    const thrown = (run: () => void) => {
      try {
        run();
      } catch (error) {
        return (error as Error).name;
      }
      return null;
    };
    let converted = 0;
    const name = {
      toString() {
        converted += 1;
        return "type";
      },
    };
    expect(
      thrown(() => (field.setAttribute as (n: unknown) => void)(name)),
    ).toBe("TypeError");
    expect(converted).toBe(0);
    expect(
      thrown(() => {
        field.type = Symbol("x") as unknown as string;
      }),
    ).toBe("TypeError");
    const set = Object.getOwnPropertyDescriptor(
      r.win.HTMLInputElement.prototype,
      "value",
    )?.set as (v: unknown) => void;
    expect(thrown(() => set.call(r.doc.createElement("div"), "x"))).toBe(
      "TypeError",
    );
    expect(r.kinds()).toEqual([]);
    expect(r.limits()).toEqual([]);
  });
  test("U2 a conversion that inserts the field before the property write clears it: judged with the value it had then", () => {
    for (const value of [MARKER, "Safe"]) {
      const r = recorder();
      const field = r.doc.createElement("input");
      field.value = value;
      field.value = {
        toString() {
          r.doc.body.append(field);
          return "";
        },
      } as unknown as string;
      expect(field.value).toBe("");
      expect(r.kinds(), value).toEqual(value === MARKER ? ["marker"] : []);
      expect(r.limits()).toEqual([]);
    }
  });
  test("U2 a conversion that inserts the field before its type sanitises it: judged with the value it had then", () => {
    const r = recorder();
    const field = r.doc.createElement("input");
    field.value = MARKER;
    field.type = {
      toString() {
        r.doc.body.append(field);
        return "number";
      },
    } as unknown as string;
    expect(field.value).toBe("");
    expect(r.kinds()).toEqual(["marker"]);
  });
});

describe("R7 R1-R4/X1: a field from ANOTHER window is read natively and observed by the document that owns it now", () => {
  for (const tag of ["input", "textarea"] as const)
    for (const how of ["adoptNode", "implicit"] as const) {
      test(`R1 ${tag} ${how}: a prefilled field from another window, inserted: reported (with its foreign prototype)`, () => {
        const r = recorder();
        const donor = donorWindow(true);
        const field = donor.doc.createElement(tag) as Field;
        field.value = MARKER;
        const moved = how === "adoptNode" ? r.doc.adoptNode(field) : field;
        r.doc.body.append(moved);
        expect(moved.ownerDocument).toBe(r.doc);
        expect(
          moved instanceof
            (tag === "input"
              ? r.win.HTMLInputElement
              : r.win.HTMLTextAreaElement),
          "the destination's prototype is not the field's",
        ).toBe(false);
        expect(moved.value).toBe(MARKER);
        expect(r.kinds()).toEqual(["marker"]);
        expect(r.limits()).toEqual([]);
      });
      test(`R1 ${tag} ${how}: a safe field from another window is clean; an imported marker copy is reported (controls)`, () => {
        const r = recorder();
        const donor = donorWindow(true);
        const safe = donor.doc.createElement(tag) as Field;
        safe.value = "Safe";
        r.doc.body.append(how === "adoptNode" ? r.doc.adoptNode(safe) : safe);
        expect(r.kinds()).toEqual([]);
        const original = donor.doc.createElement(tag) as Field;
        original.value = MARKER;
        r.doc.body.append(r.doc.importNode(original, true));
        expect(r.kinds()).toEqual(["marker"]);
        expect(r.limits()).toEqual([]);
      });
    }
  test("R2 writes after adoption, through the donor's own prototypes (setter, setRangeText, a reset) and a borrowed destination setter: each reported", () => {
    const writes: Record<string, (f: HTMLInputElement, doc: Document) => void> =
      {
        "value setter": (f) => {
          f.value = MARKER;
          f.value = "Safe";
        },
        setRangeText: (f) => {
          f.setRangeText(MARKER, 0, f.value.length);
          f.value = "Safe";
        },
        "destination setter borrowed": (f, doc) => {
          const set = Object.getOwnPropertyDescriptor(
            (doc.defaultView as Window & typeof globalThis).HTMLInputElement
              .prototype,
            "value",
          )?.set as (v: string) => void;
          set.call(f, MARKER);
          set.call(f, "Safe");
        },
        "in a nested subtree": (f) => {
          f.value = MARKER;
          f.value = "";
        },
      };
    for (const [how, write] of Object.entries(writes)) {
      const r = recorder();
      const donor = donorWindow(true);
      const holder = donor.doc.createElement("div");
      const field = donor.doc.createElement("input");
      holder.append(field);
      field.value = "Safe";
      r.doc.body.append(how === "in a nested subtree" ? holder : field);
      expect(r.kinds(), `${how}: safe so far`).toEqual([]);
      write(field, r.doc);
      expect(r.kinds(), how).toEqual(["marker"]);
      expect(r.limits(), how).toEqual([]);
    }
  });
  test("R2 control: a reset of an adopted form is ordered and leaves no stale reference (its default text is judged as text; complete)", () => {
    const r = recorder();
    const donor = donorWindow(true);
    const form = donor.doc.createElement("form");
    const field = donor.doc.createElement("textarea");
    form.append(field);
    field.value = "Safe";
    r.doc.body.append(form);
    field.defaultValue = MARKER;
    expect(r.kinds(), "the default text itself is shown").toEqual(["marker"]);
    form.reset();
    expect(field.value).toBe(MARKER);
    expect(r.limits()).toEqual([]);
  });
  test("R3 foreign attributes: an adopted element's accessible name and an adopted password field revealed are judged like local ones", () => {
    const r = recorder();
    const donor = donorWindow(true);
    const label = donor.doc.createElement("button");
    label.setAttribute("aria-label", MARKER);
    r.doc.body.append(label);
    expect(r.kinds(), "aria-label").toEqual(["marker"]);
    const field = donor.doc.createElement("input");
    field.type = "password";
    field.value = MARKER;
    r.doc.body.append(field);
    expect(r.kinds(), "still concealed").toEqual(["marker"]);
    field.type = "text";
    expect(r.kinds(), "revealed").toEqual(["marker", "marker"]);
    const safe = donor.doc.createElement("button");
    safe.setAttribute("aria-label", "Safe");
    r.doc.body.append(safe);
    expect(r.kinds(), "a safe label").toEqual(["marker", "marker"]);
  });
  test("R4 the donor's pending exposure stays the donor's; the destination judges its own insertion before the sanitisation", () => {
    const r = recorder();
    const donor = donorWindow(true);
    const field = donor.doc.createElement("input");
    field.value = MARKER;
    donor.doc.body.append(field);
    r.doc.body.append(field);
    field.type = "number";
    expect(field.value).toBe("");
    const donorKinds = (donor.win as unknown as Win).__displayOracle
      .flush()
      .violations.map((v) => v.kind);
    expect(donorKinds, "shown in the donor first").toEqual(["marker"]);
    expect(r.kinds(), "then in the destination").toEqual(["marker"]);
  });
  test("R4 moved back: the destination's exposure stands and the donor judges its own later insertion", () => {
    const r = recorder();
    const donor = donorWindow(true);
    const field = donor.doc.createElement("input");
    field.value = "Safe";
    r.doc.body.append(field);
    field.value = MARKER;
    donor.doc.body.append(field);
    field.value = "Safe";
    expect(r.kinds()).toEqual(["marker"]);
    const donorKinds = (donor.win as unknown as Win).__displayOracle
      .flush()
      .violations.map((v) => v.kind);
    expect(donorKinds).toEqual(["marker"]);
  });
  test("R4 the donor window closed: later writes to its adopted field still reach the destination", () => {
    const r = recorder();
    const donor = donorWindow(true);
    const field = donor.doc.createElement("input");
    r.doc.body.append(field);
    donor.win.close();
    field.value = MARKER;
    field.value = "";
    expect(r.kinds()).toEqual(["marker"]);
  });
  test("X1 type × realm: a foreign prefilled field inserted, then sanitised by its own window's type setter: reported; safe twin clean", () => {
    for (const value of [MARKER, "Safe"]) {
      const r = recorder();
      const donor = donorWindow(true);
      const field = donor.doc.createElement("input");
      field.value = value;
      r.doc.body.append(field);
      field.type = "number";
      expect(field.value).toBe("");
      expect(r.kinds(), value).toEqual(value === MARKER ? ["marker"] : []);
      expect(r.limits()).toEqual([]);
    }
  });
  test("X1 attribute route: the same through the foreign element's setAttribute", () => {
    const r = recorder();
    const donor = donorWindow(true);
    const field = donor.doc.createElement("input");
    field.value = MARKER;
    r.doc.body.append(field);
    field.setAttribute("type", "number");
    expect(r.kinds()).toEqual(["marker"]);
  });
  test("R1 a field from a window WITHOUT a recorder is incomplete when adopted (its writes cannot be ordered), never silently clean", () => {
    const r = recorder();
    const donor = donorWindow(false);
    const field = donor.doc.createElement("input");
    field.value = "Safe";
    r.doc.body.append(field);
    expect(r.limits()).toContain(
      "a field from a realm with no recorder was adopted (its writes are not ordered)",
    );
    expect(r.limits()).toContain(
      "a field from a realm with no recorder was shown (its writes are not ordered)",
    );
  });
  test("U1 HF-14 does not travel: what the person typed in another window is the application's disclosure once adopted", () => {
    const r = recorder();
    const donor = donorWindow(true);
    const field = donor.doc.createElement("input");
    donor.doc.body.append(field);
    typeInto(field, MARKER);
    expect(
      (donor.win as unknown as Win).__displayOracle
        .flush()
        .violations.map((v) => v.kind),
      "the person's own entry in its own document",
    ).toEqual([]);
    r.doc.body.append(field);
    expect(r.kinds()).toEqual(["marker"]);
  });
});

/**
 * WEB-08c revision 8 (R5-A of review 8; design assessment P1-P4, S1-S14): an operation that runs the application's handlers and then a
 * default action is an INTERVAL. What a handler shows is judged before the default action can change it; what cannot be ordered inside
 * the interval is incomplete; references are refreshed only after what is queued is judged. jsdom limits (native-only schedules in
 * `fixture.lifecycle-oracle.spec.ts`): no `execCommand`, no activation of a DETACHED form's reset button, and no suppression of a form's
 * reset inside its own reset handler. jsdom's own `reset()` (its implementation, reached through no wrapper) fires the trusted reset event
 * a genuine activation fires; jsdom's own `appendChild`/`setAttributeNS` are routes the recorder does not order (as a window without one).
 */
describe("R8 S1-S14: a handler's exposure inside a reset, an activation or a dispatch survives the default action", () => {
  type Field = HTMLInputElement | HTMLTextAreaElement;
  const make = (r: ReturnType<typeof recorder>, tag: "input" | "textarea") =>
    r.doc.createElement(tag) as Field;
  type Impl = {
    appendChild(node: unknown): unknown;
    removeChild(node: unknown): unknown;
    setAttributeNS(ns: string | null, name: string, value: string): void;
    reset(): void;
  };
  const impl = (node: unknown) => idl.implForWrapper(node) as unknown as Impl;
  /** A structural route the recorder does not order (jsdom's own implementation). */
  const unorderedInsert = (parent: Node, child: Node) =>
    impl(parent).appendChild(impl(child));
  const unorderedRemove = (parent: Node, child: Node) =>
    impl(parent).removeChild(impl(child));
  /** A reset no wrapper sees: the trusted event and the default action, as a person's activation of a reset button makes them. */
  const genuineReset = (form: HTMLFormElement) => impl(form).reset();
  const detachedForm = (
    r: ReturnType<typeof recorder>,
    tag: "input" | "textarea",
    value: string,
  ) => {
    const form = r.doc.createElement("form");
    const field = make(r, tag);
    field.value = value;
    form.append(field);
    return { form, field };
  };

  for (const tag of ["input", "textarea"] as const) {
    test(`S1 ${tag}: the review's probe: a detached form's reset handler shows it and removes it; the reset then empties it: reported`, () => {
      const r = recorder();
      const { form, field } = detachedForm(r, tag, MARKER);
      const seen: Array<[boolean, string]> = [];
      form.addEventListener("reset", () => {
        r.doc.body.append(form);
        seen.push([field.isConnected, field.value]);
        form.remove();
      });
      form.reset();
      expect(seen, "native precondition: shown with the marker").toEqual([
        [true, MARKER],
      ]);
      expect(field.value, "native precondition: the reset emptied it").toBe("");
      expect(r.kinds()).toEqual(["marker"]);
      expect(r.limits()).toEqual([]);
    });
    test(`S1 ${tag}: controls: a safe value is clean; a cancelled reset and an exposure with no reset are reported`, () => {
      const safe = recorder();
      const s = detachedForm(safe, tag, "Safe");
      s.form.addEventListener("reset", () => {
        safe.doc.body.append(s.form);
        s.form.remove();
      });
      s.form.reset();
      expect(s.field.value).toBe("");
      expect(safe.kinds()).toEqual([]);
      expect(safe.limits()).toEqual([]);
      const cancelled = recorder();
      const c = detachedForm(cancelled, tag, MARKER);
      c.form.addEventListener("reset", (event) => {
        cancelled.doc.body.append(c.form);
        c.form.remove();
        event.preventDefault();
      });
      c.form.reset();
      expect(c.field.value, "a cancelled reset changes nothing").toBe(MARKER);
      expect(cancelled.kinds()).toEqual(["marker"]);
      expect(cancelled.limits()).toEqual([]);
      const kept = recorder();
      const k = detachedForm(kept, tag, MARKER);
      kept.doc.body.append(k.form);
      k.form.remove();
      expect(kept.kinds()).toEqual(["marker"]);
    });
    test(`S2 ${tag}: a connected form's reset button activated by click() and by a dispatched click; the handler's insertion is reported`, () => {
      for (const how of ["click()", "dispatched click"] as const) {
        for (const value of [MARKER, "Safe"]) {
          const r = recorder();
          const form = r.doc.createElement("form");
          const button = r.doc.createElement("button");
          button.type = "reset";
          form.append(button);
          r.doc.body.append(form);
          const field = make(r, tag);
          field.value = value;
          button.addEventListener("click", () => form.append(field));
          if (how === "click()") button.click();
          else
            button.dispatchEvent(
              new r.win.MouseEvent("click", {
                bubbles: true,
                cancelable: true,
              }),
            );
          expect(field.value, `${how}: the activation reset it`).toBe("");
          expect(r.kinds(), `${how} ${value}`).toEqual(
            value === MARKER ? ["marker"] : [],
          );
          expect(r.limits(), how).toEqual([]);
        }
      }
    });
    test(`S2 ${tag}: control: a click whose activation is cancelled leaves the value; the exposure is still reported once`, () => {
      const r = recorder();
      const form = r.doc.createElement("form");
      const button = r.doc.createElement("button");
      button.type = "reset";
      form.append(button);
      r.doc.body.append(form);
      const field = make(r, tag);
      field.value = MARKER;
      button.addEventListener("click", (event) => {
        form.append(field);
        event.preventDefault();
      });
      button.click();
      expect(field.value).toBe(MARKER);
      expect(r.kinds()).toEqual(["marker"]);
      expect(r.limits()).toEqual([]);
    });
    test(`S3 ${tag}: a handler AFTER the window's capture (target phase, propagation stopped or not) shows a field the reset empties: reported`, () => {
      for (const stop of [false, true]) {
        for (const genuine of [false, true]) {
          const r = recorder();
          const form = r.doc.createElement("form");
          r.doc.body.append(form);
          const field = make(r, tag);
          field.value = MARKER;
          form.addEventListener("reset", (event) => {
            if (stop) event.stopPropagation();
            form.append(field);
          });
          if (genuine) genuineReset(form);
          else form.reset();
          const label = `stop=${stop} genuine=${genuine}`;
          expect(field.value, label).toBe("");
          expect(r.kinds(), label).toEqual(["marker"]);
          expect(r.limits(), label).toEqual([]);
          // The reference settles after the dispatch: the emptied field moved again is complete and clean.
          field.remove();
          r.doc.body.append(field);
          expect(r.kinds(), label).toEqual(["marker"]);
          expect(r.limits(), label).toEqual([]);
        }
      }
    });
    test(`S4 ${tag}: values changed inside the handler are judged in order (no entry snapshot, no final equality)`, () => {
      const schedules: Array<[string, string, (f: Field) => void, string[]]> = [
        [
          "safe → marker → shown",
          "Safe",
          (f) => {
            f.value = MARKER;
          },
          ["marker"],
        ],
        [
          "marker → safe → shown",
          MARKER,
          (f) => {
            f.value = "Safe";
          },
          [],
        ],
      ];
      for (const [label, initial, before, expected] of schedules) {
        const r = recorder();
        const { form, field } = detachedForm(r, tag, initial);
        form.addEventListener("reset", () => {
          before(field);
          r.doc.body.append(form);
          form.remove();
        });
        form.reset();
        expect(field.value, label).toBe("");
        expect(r.kinds(), label).toEqual(expected);
        expect(r.limits(), label).toEqual([]);
      }
      const r = recorder();
      const { form, field } = detachedForm(r, tag, MARKER);
      form.addEventListener("reset", () => {
        r.doc.body.append(form);
        field.value = "Safe";
        field.value = MARKER;
        form.remove();
      });
      form.reset();
      expect(r.kinds(), "marker → safe → marker while shown").toEqual([
        "marker",
        "marker",
      ]);
      expect(r.limits()).toEqual([]);
    });
    test(`S5 ${tag}: participants that change inside the handler (created, removed, associated by attribute, another form)`, () => {
      // Created in the handler.
      const created = recorder();
      const form = created.doc.createElement("form");
      let made: Field | null = null;
      form.addEventListener("reset", () => {
        made = make(created, tag);
        made.value = MARKER;
        form.append(made);
        created.doc.body.append(form);
        form.remove();
      });
      form.reset();
      expect((made as Field | null)?.value, "created and reset").toBe("");
      expect(created.kinds()).toEqual(["marker"]);
      expect(created.limits()).toEqual([]);
      // Removed from the form before the reset: never shown (clean), not reset, and judged with its true value when shown later.
      const removed = recorder();
      const r = detachedForm(removed, tag, MARKER);
      r.form.addEventListener("reset", () => r.form.removeChild(r.field));
      r.form.reset();
      expect(r.field.value, "not a participant of the reset").toBe(MARKER);
      expect(removed.kinds()).toEqual([]);
      removed.doc.body.append(r.field);
      expect(removed.kinds()).toEqual(["marker"]);
      expect(removed.limits()).toEqual([]);
      // Associated by its form attribute when the handler shows it.
      const associated = recorder();
      const owner = associated.doc.createElement("form");
      owner.id = "owner";
      associated.doc.body.append(owner);
      const field = make(associated, tag);
      field.value = MARKER;
      field.setAttribute("form", "owner");
      owner.addEventListener("reset", () => associated.doc.body.append(field));
      owner.reset();
      expect(field.value, "associated by its attribute, reset").toBe("");
      expect(associated.kinds()).toEqual(["marker"]);
      expect(associated.limits()).toEqual([]);
      // Another (detached) form reset by this one's handler.
      const other = recorder();
      const a = detachedForm(other, tag, "Safe");
      const b = detachedForm(other, tag, MARKER);
      b.form.addEventListener("reset", () => {
        other.doc.body.append(b.form);
        b.form.remove();
      });
      a.form.addEventListener("reset", () => b.form.reset());
      a.form.reset();
      expect([a.field.value, b.field.value]).toEqual(["", ""]);
      expect(other.kinds()).toEqual(["marker"]);
      expect(other.limits()).toEqual([]);
    });
    test(`S6 ${tag}: nested operations: a dispatch inside a reset exposes; the inner exposure stands after both default actions`, () => {
      const r = recorder();
      const { form, field } = detachedForm(r, tag, MARKER);
      const relay = r.doc.createElement("span");
      relay.addEventListener("expose", () => {
        r.doc.body.append(form);
        form.remove();
      });
      form.addEventListener("reset", () =>
        relay.dispatchEvent(new r.win.Event("expose")),
      );
      form.reset();
      expect(field.value).toBe("");
      expect(r.kinds()).toEqual(["marker"]);
      expect(r.limits()).toEqual([]);
      const twin = recorder();
      const t = detachedForm(twin, tag, "Safe");
      const relayTwin = twin.doc.createElement("span");
      relayTwin.addEventListener("expose", () => {
        twin.doc.body.append(t.form);
        t.form.remove();
      });
      t.form.addEventListener("reset", () =>
        relayTwin.dispatchEvent(new twin.win.Event("expose")),
      );
      t.form.reset();
      expect(twin.kinds(), "safe twin").toEqual([]);
      expect(twin.limits()).toEqual([]);
    });
    test(`S7 ${tag}: a conversion that shows the field and then throws: the exposure stands, the native error is kept`, () => {
      const r = recorder();
      const { form, field } = detachedForm(r, tag, MARKER);
      const bad = {
        toString() {
          r.doc.body.append(form);
          form.remove();
          throw new r.win.Error("conversion refused");
        },
      };
      expect(() => {
        field.value = bad as unknown as string;
      }).toThrow("conversion refused");
      expect(field.value).toBe(MARKER);
      expect(r.kinds()).toEqual(["marker"]);
      expect(r.limits()).toEqual([]);
    });
    test(`S10 ${tag}: another window's form, reset through the donor's prototype; its handler shows it here, then in the donor`, () => {
      const r = recorder();
      const donor = donorWindow(true);
      const form = donor.doc.createElement("form");
      const field = donor.doc.createElement(tag) as Field;
      field.value = MARKER;
      form.append(field);
      r.doc.adoptNode(form);
      expect(form instanceof r.win.HTMLFormElement, "a foreign prototype").toBe(
        false,
      );
      form.addEventListener("reset", () => {
        r.doc.body.append(form);
        donor.doc.body.append(form);
        donor.doc.body.removeChild(form);
      });
      form.reset();
      expect(field.value).toBe("");
      expect(field.ownerDocument).toBe(donor.doc);
      const donorFlush = (donor.win as unknown as Win).__displayOracle.flush();
      expect(r.kinds(), "shown here").toEqual(["marker"]);
      expect(
        donorFlush.violations.map((v) => v.kind),
        "then there",
      ).toEqual(["marker"]);
      expect(r.limits()).toEqual([]);
      expect(donorFlush.limits).toEqual([]);
      // Each document's reference is the field's value now: shown again in either, it is clean and complete.
      r.doc.body.append(form);
      expect(r.kinds()).toEqual(["marker"]);
      expect(r.limits()).toEqual([]);
    });
    test(`S14 ${tag}: an UNORDERED insertion inside the reset interval is incomplete, never clean; its safe twin is complete and clean`, () => {
      for (const value of [MARKER, "Safe"]) {
        const r = recorder();
        const { form, field } = detachedForm(r, tag, value);
        form.addEventListener("reset", () => {
          unorderedInsert(r.doc.body, form);
          unorderedRemove(r.doc.body, form);
        });
        form.reset();
        expect(field.value).toBe("");
        expect(r.kinds(), value).toEqual([]);
        expect(r.limits(), value).toEqual(
          value === MARKER
            ? [
                "a field's value was changed by a route that is not ordered (its value at a record is unknown)",
              ]
            : [],
        );
      }
    });
  }

  test("S3/S14 genuine reset: an unordered reveal inside its handler is incomplete (the reference is kept until the dispatch ends); safe twin clean", () => {
    for (const value of [MARKER, "Safe"]) {
      const r = recorder();
      const form = r.doc.createElement("form");
      const field = r.doc.createElement("input");
      field.type = "password";
      field.value = value;
      form.append(field);
      r.doc.body.append(form);
      form.addEventListener("reset", () =>
        impl(field).setAttributeNS(null, "type", "text"),
      );
      genuineReset(form);
      expect([field.type, field.value]).toEqual(["text", ""]);
      expect(r.kinds(), value).toEqual([]);
      expect(r.limits(), value).toEqual(
        value === MARKER
          ? [
              "a field's value was changed by a route that is not ordered (its value at a record is unknown)",
            ]
          : [],
      );
    }
  });
  test("S3 genuine reset: the reference settles when the dispatch has ended (a later ordered reveal of the emptied field is clean)", () => {
    const r = recorder();
    const form = r.doc.createElement("form");
    const field = r.doc.createElement("input");
    field.type = "password";
    field.value = MARKER;
    form.append(field);
    r.doc.body.append(form);
    genuineReset(form);
    expect(field.value).toBe("");
    field.type = "text";
    expect(r.kinds()).toEqual([]);
    expect(r.limits()).toEqual([]);
  });
  test("S3 a script-dispatched reset event has no default action: nothing is held for it", () => {
    const r = recorder();
    const form = r.doc.createElement("form");
    const field = r.doc.createElement("input");
    field.type = "password";
    field.value = MARKER;
    form.append(field);
    r.doc.body.append(form);
    form.dispatchEvent(new r.win.Event("reset", { cancelable: true }));
    expect(field.value).toBe(MARKER);
    field.type = "text";
    expect(r.kinds(), "revealed").toEqual(["marker"]);
    expect(r.limits()).toEqual([]);
  });
  test("bounds: operations nested over the limit are incomplete", () => {
    const r = recorder({ limits: { operations: 2 } });
    const forms = [0, 1, 2].map(() => r.doc.createElement("form"));
    forms[0]?.addEventListener("reset", () => forms[1]?.reset());
    forms[1]?.addEventListener("reset", () => forms[2]?.reset());
    forms[0]?.reset();
    expect(r.limits()).toEqual(["operations nested over 2 deep"]);
  });
  test("U1 (revision 8): an unordered change AFTER an ordered insertion was judged is asked at collection: incomplete when it decides", () => {
    const r = recorder();
    const field = r.doc.createElement("textarea");
    field.value = "Safe";
    r.doc.body.append(field);
    expect(r.limits(), "judged when inserted").toEqual([]);
    idl.implForWrapper(field).value = MARKER;
    expect(r.limits()).toEqual([
      "a field's value was changed by a route that is not ordered (its value at a record is unknown)",
    ]);
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
    // Revision 8 adaptation (labelled): appends are judged one by one when each returns, so the batch is made of attribute records
    // (an element's own attributes are not an ordered route).
    const holder = r.doc.createElement("div");
    r.doc.body.append(holder);
    for (let i = 0; i < 5; i += 1) holder.setAttribute("title", `Safe ${i}`);
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
