import { describe, it, expect } from "vitest";
import {
  allocateSchedule,
  type AllocateScheduleInput,
  type ScheduleQuestionInput,
} from "./allocateSchedule.js";

const REQUIREMENTS: AllocateScheduleInput["requirements"] = [
  { id: "r1", priority: "must" },
  { id: "r2", priority: "nice" },
];

function q(id: string, reqIds: string[], difficulty: 1 | 2 | 3): ScheduleQuestionInput {
  return { id, requirement_ids: reqIds, difficulty };
}

/** All question ids across every day, in day order. */
function allIds(schedule: ReturnType<typeof allocateSchedule>): string[] {
  return schedule.days.flatMap((d) => d.question_ids);
}

describe("allocateSchedule", () => {
  it("puts all questions into day 1 for a 1-day schedule", () => {
    const questions = [q("qa", ["r1"], 2), q("qb", ["r2"], 1)];
    const out = allocateSchedule({ daysAvailable: 1, questions, requirements: REQUIREMENTS });

    expect(out.days).toHaveLength(1);
    expect(out.days[0].day).toBe(1);
    expect(out.days[0].question_ids.sort()).toEqual(["qa", "qb"]);
    expect(out.days[0].minutes).toBe(15 + 10);
  });

  it("produces a normal multi-day schedule", () => {
    const questions = [
      q("qa", ["r1"], 3),
      q("qb", ["r1"], 2),
      q("qc", ["r2"], 1),
      q("qd", ["r2"], 1),
    ];
    const out = allocateSchedule({ daysAvailable: 2, questions, requirements: REQUIREMENTS });

    expect(out.days_available).toBe(2);
    expect(out.days).toHaveLength(2);
    // 4 questions over 2 days -> 2 each.
    expect(out.days[0].question_ids).toHaveLength(2);
    expect(out.days[1].question_ids).toHaveLength(2);
  });

  it("creates exactly daysAvailable day buckets", () => {
    const questions = [q("qa", ["r1"], 1), q("qb", ["r1"], 1), q("qc", ["r1"], 1)];
    const out = allocateSchedule({ daysAvailable: 3, questions, requirements: REQUIREMENTS });

    expect(out.days).toHaveLength(3);
    expect(out.days.map((d) => d.day)).toEqual([1, 2, 3]);
  });

  it("schedules every question exactly once", () => {
    const questions = [
      q("qa", ["r1"], 3),
      q("qb", ["r1"], 2),
      q("qc", ["r2"], 1),
      q("qd", ["r2"], 2),
      q("qe", ["r1"], 1),
    ];
    const out = allocateSchedule({ daysAvailable: 3, questions, requirements: REQUIREMENTS });

    const ids = allIds(out).sort();
    expect(ids).toEqual(["qa", "qb", "qc", "qd", "qe"]);
    expect(new Set(ids).size).toBe(5); // no duplicates
  });

  it("schedules higher-weight questions earlier", () => {
    // weights: hi = must(2)×3 = 6, lo = nice(1)×1 = 1
    const questions = [q("lo", ["r2"], 1), q("hi", ["r1"], 3)];
    const out = allocateSchedule({ daysAvailable: 2, questions, requirements: REQUIREMENTS });

    expect(out.days[0].question_ids).toEqual(["hi"]);
    expect(out.days[1].question_ids).toEqual(["lo"]);
  });

  it("calculates minutes from difficulty", () => {
    const questions = [q("d1", ["r1"], 1), q("d2", ["r1"], 2), q("d3", ["r1"], 3)];
    const out = allocateSchedule({ daysAvailable: 1, questions, requirements: REQUIREMENTS });

    expect(out.days[0].minutes).toBe(10 + 15 + 20);
    expect(Number.isInteger(out.days[0].minutes)).toBe(true);
  });

  it("ensures every must requirement appears in the schedule", () => {
    const questions = [q("qa", ["r1"], 2), q("qb", ["r2"], 1)];
    const out = allocateSchedule({ daysAvailable: 2, questions, requirements: REQUIREMENTS });

    const scheduledReqIds = new Set(
      out.days.flatMap((d) =>
        d.question_ids.flatMap(
          (id) => questions.find((qq) => qq.id === id)!.requirement_ids,
        ),
      ),
    );
    for (const req of REQUIREMENTS.filter((r) => r.priority === "must")) {
      expect(scheduledReqIds.has(req.id)).toBe(true);
    }
  });

  it("creates review days when daysAvailable exceeds question count", () => {
    const questions = [q("qa", ["r1"], 2)];
    const out = allocateSchedule({ daysAvailable: 3, questions, requirements: REQUIREMENTS });

    expect(out.days).toHaveLength(3);
    expect(allIds(out)).toEqual(["qa"]); // question not lost/duplicated
    // Trailing days are empty review days.
    expect(out.days[1].question_ids).toEqual([]);
    expect(out.days[2].question_ids).toEqual([]);
    expect(out.days[1].minutes).toBe(0);
    expect(out.days[1].focus).toMatch(/review/i);
  });

  it("throws clearly on zero/invalid days", () => {
    const questions = [q("qa", ["r1"], 1)];

    expect(() => allocateSchedule({ daysAvailable: 0, questions, requirements: REQUIREMENTS })).toThrow(
      /positive integer/i,
    );
    expect(() => allocateSchedule({ daysAvailable: -2, questions, requirements: REQUIREMENTS })).toThrow();
    expect(() => allocateSchedule({ daysAvailable: 1.5, questions, requirements: REQUIREMENTS })).toThrow();
  });

  it("does not mutate the input questions array", () => {
    const questions = [q("lo", ["r2"], 1), q("hi", ["r1"], 3)];
    const snapshot = JSON.parse(JSON.stringify(questions));

    allocateSchedule({ daysAvailable: 2, questions, requirements: REQUIREMENTS });

    expect(questions).toEqual(snapshot); // order + contents unchanged
  });
});
