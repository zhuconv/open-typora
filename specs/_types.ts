// Test/spec data types — separated from FeatureSpec so the lib bundle
// stays free of test fixtures and DOM-projection helpers.
//
// A FeatureSpecs is the dual to a FeatureSpec: it carries the data
// consumed by the test runner (assertion checkpoints) and by the
// website's specs panel (event-stream demos). Both consumers walk the
// `cases` array; renderCases feeds pretty() (also dual-use across
// tests + harness).

import type { Event } from "./events.ts";

// A Case is one scripted scenario — seed text plus an event stream — with
// one or more Checkpoints along the way that assert pretty() output. One
// data shape, two consumers:
//   - the feature's test file runs each checkpoint as an independent test
//     (slice events up to cp.at, assert pretty equals cp.expect), so
//     intermediate invariants stay covered.
//   - the website's specs panel lists each case as a single preset that
//     plays the full event stream; cp.expect can be shown alongside as a
//     visual oracle. This keeps "cases are the spec in both places"
//     literal, not copy-pasted.
export type Checkpoint = {
  at: number;      // assert after the first `at` events have been fed (0 = seed state)
  expect: string;  // pretty() output at that point
};

export type Case = {
  id: string;
  label: string;
  seed: string;
  events: Event[];
  checkpoints: Checkpoint[];
};

// A handler can return `null` to mean "not my element — try the next
// handler registered for the same tag". Lets multiple features claim the
// same generic tag (e.g. `<div>` for both toc and math-block) without
// stomping on each other.
export type RenderCase = (children: string, el: Element) => string | null;

export type FeatureSpecs = {
  name: string;
  cases?: Case[];
  renderCases?: Record<string, RenderCase>;
};
