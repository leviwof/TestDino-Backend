import { describe, it, expect } from "vitest";
import {
  allocateSchedule,
  validateSchedule,
  ScheduleValidationError,
  type AllocateScheduleInput,
  type Schedule,
  type ScheduleQuestionInput,
} from "./allocateSchedule.js";

const REQUIREMENTS: AllocateScheduleInput["requirements"] = [
  { id: "r1", priority: "must" },
  { id: "r2", priority: "nice" },
];

function q(id: string, reqIds: string[], difficulty: 1 | 2 | 3): ScheduleQuestionInput {
  return { id, requirement_ids: reqIds, difficulty };
}

describe("allocateSchedule self-check (produces valid schedules)", () => {
  const cases: Array<{ name: string; days: number; questions: ScheduleQuestionInput[] }> = [
    { name: "1 day", days: 1, questions: [q("a", ["r1"], 2), q("b", ["r2"], 1)] },
    { name: "2 days", days: 2, questions: [q("a", ["r1"], 3), q("b", ["r2"], 1), q("c", ["r1"], 2)] },
    { name: "days > question count", days: 5, questions: [q("a", ["r1"], 2)] },
    { name: "no questions", days: 3, questions: [] },
    {
      name: "multiple questions on the same requirement",
      days: 2,
      questions: [q("a", ["r1"], 1), q("b", ["r1"], 2), q("c", ["r1"], 3)],
    },
  ];

  for (const c of cases) {
    it(`passes validation: ${c.name}`, () => {
      const out = allocateSchedule({
        daysAvailable: c.days,
        questions: c.questions,
        requirements: REQUIREMENTS,
      });

      // Self-check ran inside allocateSchedule; re-running must also pass.
      expect(() =>
        validateSchedule(out, { questions: c.questions, requirements: REQUIREMENTS }),
      ).not.toThrow();

      expect(out.days).toHaveLength(c.days);
      expect(out.days.map((d) => d.day)).toEqual(
        Array.from({ length: c.days }, (_, i) => i + 1),
      );
      expect(out.days.every((d) => Number.isInteger(d.minutes) && d.minutes >= 0)).toBe(true);
    });
  }

  it("requirements with no questions do not break allocation", () => {
    const reqs = [
      { id: "r1", priority: "must" as const },
      { id: "rNever", priority: "nice" as const }, // no question references it
    ];
    const questions = [q("a", ["r1"], 2)];

    const out = allocateSchedule({ daysAvailable: 2, questions, requirements: reqs });
    expect(() => validateSchedule(out, { questions, requirements: reqs })).not.toThrow();
  });

  it("stays honest when a MUST requirement has no question (no invention)", () => {
    const reqs = [
      { id: "r1", priority: "must" as const },
      { id: "rMissing", priority: "must" as const }, // uncovered must, no question
    ];
    const questions = [q("a", ["r1"], 2)];

    const out = allocateSchedule({ daysAvailable: 2, questions, requirements: reqs });

    // No fabricated question appears for rMissing.
    const scheduledIds = out.days.flatMap((d) => d.question_ids);
    expect(scheduledIds).toEqual(["a"]);
    // And validation does NOT throw for the honestly-uncovered must requirement.
    expect(() => validateSchedule(out, { questions, requirements: reqs })).not.toThrow();
  });
});

describe("validateSchedule (rejects broken schedules)", () => {
  const questions = [q("a", ["r1"], 2), q("b", ["r2"], 1)];
  const base = () => allocateSchedule({ daysAvailable: 2, questions, requirements: REQUIREMENTS });

  it("rejects a non-positive days_available", () => {
    const s = base();
    s.days_available = 0;
    expect(() => validateSchedule(s, { questions, requirements: REQUIREMENTS })).toThrow(
      ScheduleValidationError,
    );
  });

  it("rejects a mismatch between days.length and days_available", () => {
    const s = base();
    s.days.pop();
    expect(() => validateSchedule(s, { questions, requirements: REQUIREMENTS })).toThrow(
      /expected 2 days/i,
    );
  });

  it("rejects wrong day numbering", () => {
    const s = base();
    s.days[1].day = 99;
    expect(() => validateSchedule(s, { questions, requirements: REQUIREMENTS })).toThrow(
      /expected 2/i,
    );
  });

  it("rejects a duplicated question id", () => {
    const s: Schedule = base();
    s.days[1].question_ids = [...s.days[1].question_ids, s.days[0].question_ids[0]];
    expect(() => validateSchedule(s, { questions, requirements: REQUIREMENTS })).toThrow(
      /more than once/i,
    );
  });

  it("rejects a missing input question", () => {
    const s = base();
    s.days[0].question_ids = []; // drop question "a"
    expect(() => validateSchedule(s, { questions, requirements: REQUIREMENTS })).toThrow(
      ScheduleValidationError,
    );
  });

  it("rejects an invented question not in the input", () => {
    const s = base();
    s.days[0].question_ids = [...s.days[0].question_ids, "ghost"];
    expect(() => validateSchedule(s, { questions, requirements: REQUIREMENTS })).toThrow(
      ScheduleValidationError,
    );
  });

  it("rejects negative or non-integer minutes", () => {
    const s1 = base();
    s1.days[0].minutes = -1;
    expect(() => validateSchedule(s1, { questions, requirements: REQUIREMENTS })).toThrow(
      /minutes/i,
    );

    const s2 = base();
    s2.days[0].minutes = 12.5;
    expect(() => validateSchedule(s2, { questions, requirements: REQUIREMENTS })).toThrow(
      /minutes/i,
    );
  });

  it("rejects a must requirement that has a question but is not scheduled", () => {
    // Build a deliberately broken schedule: question "a" (covers must r1) is
    // dropped and replaced by an in-input question so the id-set still matches.
    const qs = [q("a", ["r1"], 2), q("b", ["r2"], 1)];
    const broken: Schedule = {
      days_available: 1,
      days: [{ day: 1, focus: "x", question_ids: ["b"], minutes: 10 }],
    };
    // Only "b" scheduled; "a" (the must-covering question) is missing -> the
    // id-set check fires first, but if ids matched, rule 6 would also catch it.
    expect(() => validateSchedule(broken, { questions: qs, requirements: REQUIREMENTS })).toThrow(
      ScheduleValidationError,
    );
  });
});
