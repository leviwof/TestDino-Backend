import {
  toCoreKit,
  type CoreKit,
  type CompanyBrief,
  type Flashcard,
  type Question,
  type ResearchStatus,
  type Role,
  type Schedule,
  type Source,
} from "../schema/kit.js";
import { validateKit } from "../schema/validateKit.js";
import { extractRequirements } from "../extraction/requirements.js";
import { crawlSite, type CrawledPage, type CrawlResult } from "../retrieval/crawler.js";
import { searchPublicDiscussion } from "../retrieval/discussions.js";
import { generateCompanyBrief } from "../generation/companyBrief.js";
import { generateAllQuestions } from "../generation/questions.js";
import { generateFlashcards } from "../generation/flashcards.js";
import { runCoverageLoop } from "../coverage/coverageLoop.js";
import { allocateSchedule } from "../scheduling/allocateSchedule.js";

/**
 * Interview-kit pipeline orchestrator.
 *
 * runPipeline(input) connects the existing modules end-to-end and returns a
 * validated CoreKit. It contains NO business logic of its own beyond glue: each
 * stage is an existing function, wired so one stage's output feeds the next.
 *
 * Stage order:
 *   1. Requirement extraction   (extractRequirements)
 *   2. Company website crawling (crawlSite)
 *   3. Public discussion search (searchPublicDiscussion)
 *   4. Company brief generation (generateCompanyBrief)
 *   5. Hiring context extraction (extractHiringContext — deterministic, over the
 *      pages already crawled in stage 2; no extra network/LLM calls)
 *   6. Question generation      (generateAllQuestions)
 *   7. Coverage loop            (runCoverageLoop)
 *   8. Flashcard generation     (generateFlashcards)
 *   9. Schedule allocation      (allocateSchedule)
 *  10. Final kit validation     (validateKit / CoreKitSchema)
 *
 * Honesty: sparse research yields an honest brief (stage 4 handles that),
 * unavailable discussions yield discussion_found=false, and unreachable sources
 * are recorded as-is. Nothing is fabricated to fill gaps.
 *
 * The output type is CoreKit. Research metadata that has no home in CoreKit
 * (unreachable sources, discussion/hiring flags) is recorded on the fully
 * assembled *stored* kit, which is what validateKit() checks; toCoreKit() then
 * projects it down to the CoreKit shape returned to the caller.
 */

export interface RunPipelineInput {
  jd: string;
  company_url: string;
  role?: string;
  location?: string;
  days: number;
}

export interface HiringContext {
  hiring_page_found: boolean;
}

/**
 * Deterministic hiring-context extraction over already-crawled pages: did the
 * crawl surface a careers/jobs/hiring page? Pure, no network, no LLM.
 */
export function extractHiringContext(pages: CrawledPage[]): HiringContext {
  const HIRING = /(careers?|jobs?|hiring|join[-\s]?us|work[-\s]?with[-\s]?us|open[-\s]?roles?|positions?|vacanc)/i;
  const hiring_page_found = pages.some(
    (p) => HIRING.test(p.url) || HIRING.test(p.text),
  );
  return { hiring_page_found };
}

/**
 * A single, honest progress ping for the pipeline's current stage.
 *
 * `status` is the coarse job status this stage belongs to (the job lifecycle
 * only has queued -> crawling -> generating), while `message` is the specific,
 * user-facing description of the work happening right now.
 */
export interface PipelineStageProgress {
  step: PipelineStep;
  status: "crawling" | "generating";
  message: string;
}

export type PipelineStep =
  | "requirements"
  | "crawl"
  | "discussions"
  | "brief"
  | "hiring"
  | "questions"
  | "coverage"
  | "flashcards"
  | "schedule"
  | "validation";

/**
 * The ordered stage table: the single source of truth for what the pipeline is
 * doing and how to say it. Messages describe work that is actually happening at
 * that moment — no invented steps, no fake percentages.
 */
export const PIPELINE_STAGES: readonly PipelineStageProgress[] = [
  {
    step: "requirements",
    status: "crawling",
    message: "Reading the job description and pulling out the key requirements…",
  },
  {
    step: "crawl",
    status: "crawling",
    message: "Crawling the company site — about, careers, and engineering pages…",
  },
  {
    step: "discussions",
    status: "crawling",
    message: "Looking for public interview discussions about this company…",
  },
  {
    step: "brief",
    status: "generating",
    message: "Writing a company brief grounded in the pages we read…",
  },
  {
    step: "hiring",
    status: "generating",
    message: "Checking what they're hiring for right now…",
  },
  {
    step: "questions",
    status: "generating",
    message: "Drafting interview questions and answer outlines…",
  },
  {
    step: "coverage",
    status: "generating",
    message: "Checking every requirement is covered — closing any gaps…",
  },
  {
    step: "flashcards",
    status: "generating",
    message: "Building flashcards for quick review…",
  },
  {
    step: "schedule",
    status: "generating",
    message: "Laying out your day-by-day study schedule…",
  },
  {
    step: "validation",
    status: "generating",
    message: "Double-checking everything before handing it over…",
  },
];

const STAGE_BY_STEP: Record<PipelineStep, PipelineStageProgress> = Object.fromEntries(
  PIPELINE_STAGES.map((s) => [s.step, s]),
) as Record<PipelineStep, PipelineStageProgress>;

/** Injectable stage overrides for testing. Each defaults to the real module. */
export interface RunPipelineDeps {
  /**
   * Called (and awaited) as each stage begins, so a caller can mirror real
   * progress to the outside world. Defaults to a no-op.
   */
  onStage?: (progress: PipelineStageProgress) => void | Promise<void>;
  extractRequirements?: typeof extractRequirements;
  crawlSite?: typeof crawlSite;
  searchPublicDiscussion?: typeof searchPublicDiscussion;
  generateCompanyBrief?: typeof generateCompanyBrief;
  extractHiringContext?: typeof extractHiringContext;
  generateAllQuestions?: typeof generateAllQuestions;
  runCoverageLoop?: typeof runCoverageLoop;
  generateFlashcards?: typeof generateFlashcards;
  allocateSchedule?: typeof allocateSchedule;
  /** Injectable clock (for deterministic timestamps in tests). */
  now?: () => Date;
}

/** Best-effort company name from the URL host (deterministic, never fabricated data). */
function companyNameFromUrl(companyUrl: string): string {
  try {
    const host = new URL(companyUrl).hostname.replace(/^www\./, "");
    const label = host.split(".")[0];
    return label || host;
  } catch {
    return companyUrl;
  }
}

export async function runPipeline(
  input: RunPipelineInput,
  deps: RunPipelineDeps = {},
): Promise<CoreKit> {
  const doExtractRequirements = deps.extractRequirements ?? extractRequirements;
  const doCrawlSite = deps.crawlSite ?? crawlSite;
  const doSearchDiscussion = deps.searchPublicDiscussion ?? searchPublicDiscussion;
  const doGenerateBrief = deps.generateCompanyBrief ?? generateCompanyBrief;
  const doExtractHiring = deps.extractHiringContext ?? extractHiringContext;
  const doGenerateQuestions = deps.generateAllQuestions ?? generateAllQuestions;
  const doRunCoverageLoop = deps.runCoverageLoop ?? runCoverageLoop;
  const doGenerateFlashcards = deps.generateFlashcards ?? generateFlashcards;
  const doAllocateSchedule = deps.allocateSchedule ?? allocateSchedule;
  const now = deps.now ?? (() => new Date());

  /** Best-effort stage ping: progress must never be able to break a run. */
  const report = async (step: PipelineStep): Promise<void> => {
    if (!deps.onStage) return;
    try {
      await deps.onStage(STAGE_BY_STEP[step]);
    } catch {
      // A progress observer failing is not a pipeline failure.
    }
  };

  const company = companyNameFromUrl(input.company_url);

  // 1. Requirement extraction.
  await report("requirements");
  const extracted = await doExtractRequirements(input.jd);
  const role: Role = {
    title: extracted.title,
    seniority: extracted.seniority,
    responsibilities: extracted.responsibilities,
    requirements: extracted.requirements,
  };

  // 2. Company website crawling (unreachable site -> honest fallback with empty pages).
  await report("crawl");
  let crawl: CrawlResult;
  try {
    crawl = await doCrawlSite(input.company_url);
  } catch {
    crawl = {
      pages: [],
      unreachable: [input.company_url],
    };
  }

  // 3. Public discussion search (unavailable -> found:false, never fatal).
  await report("discussions");
  const discussion = await doSearchDiscussion(company, input.role);

  // 4. Company brief generation (sparse research -> honest brief).
  await report("brief");
  const brief: CompanyBrief = await doGenerateBrief({
    company,
    pages: crawl.pages.map((p) => ({ url: p.url, text: p.text })),
  });

  // 5. Hiring context extraction (deterministic, over crawled pages).
  await report("hiring");
  const hiring = doExtractHiring(crawl.pages);

  // 6. Question generation (grounded in role + company brief).
  await report("questions");
  const generatedQuestions: Question[] = await doGenerateQuestions({
    ...role,
    company,
    companyBrief: brief,
  });

  // 7. Coverage loop (may add targeted gap questions; reports passes + gaps).
  await report("coverage");
  const coverage = await doRunCoverageLoop({
    requirements: role.requirements,
    questions: generatedQuestions,
  });
  const questions = coverage.questions;

  // 8. Flashcard generation (from final requirements + questions).
  await report("flashcards");
  const flashcards: Flashcard[] = await doGenerateFlashcards({
    requirements: role.requirements.map((r) => ({ id: r.id, text: r.text })),
    questions: questions.map((q) => ({
      id: q.id,
      requirement_ids: q.requirement_ids,
      prompt: q.prompt,
      answer_outline: q.answer_outline,
    })),
  });

  // 9. Schedule allocation over the final question set.
  await report("schedule");
  const schedule: Schedule = doAllocateSchedule({
    daysAvailable: input.days,
    questions: questions.map((q) => ({
      id: q.id,
      requirement_ids: q.requirement_ids,
      difficulty: q.difficulty,
    })),
    requirements: role.requirements.map((r) => ({ id: r.id, priority: r.priority })),
  });

  // Assemble source + honest research metadata.
  const source: Source = {
    company,
    company_url: input.company_url,
    role: input.role ?? role.title,
    location: input.location ?? "",
    jd_chars: input.jd.length,
    researched_at: now().toISOString(),
    pages_used: crawl.pages.map((p) => p.url), // successfully crawled pages
  };

  const research_status: ResearchStatus = {
    hiring_page_found: hiring.hiring_page_found,
    discussion_found: discussion.found, // false when discussions unavailable
    unreachable_sources: crawl.unreachable, // recorded honestly
  };

  // Public-discussion findings are captured honestly as research notes.
  const research_notes = discussion.results.map(
    (r) => `Discussion: ${r.title} — ${r.url}`,
  );

  // 10. Final kit validation. Build the full stored-shaped kit so research
  // metadata is validated too, then project down to CoreKit for the caller.
  await report("validation");
  const storedKit = {
    source,
    company_brief: brief,
    role,
    questions,
    flashcards,
    schedule,
    coverage: {
      uncovered_requirement_ids: coverage.uncovered_requirement_ids,
      passes: coverage.passes,
    },
    research_notes,
    research_status,
  };

  const result = validateKit(storedKit);
  if (!result.ok || !result.kit) {
    throw new Error(`Pipeline produced an invalid kit:\n- ${result.errors.join("\n- ")}`);
  }

  return toCoreKit(result.kit);
}
