import { packedAnswerSources } from "./answer-review-options-fixture.ts";
import {
  packedAuditSources,
  packedTicketSources,
} from "./dependency-audit-template-fixture.ts";
import { packedTemplateSources } from "./develop-template-fixture.ts";
import { packedGoalSources } from "./goal-template-fixture.ts";
import { packedIdeaSources } from "./packed-idea-template.ts";
import { packedReviewSources } from "./packed-review-template.ts";
import { packedReleaseSources } from "./release-template-options-fixture.ts";
import {
  packedPatrolSources,
  packedRescueSources,
} from "./rescue-template-options-fixture.ts";
import { packedTriageSources } from "./triage-template-fixture.ts";

export const packedSources: readonly string[] = packedAnswerSources.concat(
  packedAuditSources,
  packedTicketSources,
  packedTemplateSources,
  packedGoalSources,
  packedIdeaSources,
  packedPatrolSources,
  packedReleaseSources,
  packedRescueSources,
  packedReviewSources,
  packedTriageSources,
);
