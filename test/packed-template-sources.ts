import { packedReviewSources } from "./packed-review-template.ts";
import { packedTemplateSources } from "./develop-template-fixture.ts";
import { packedAnswerSources } from "./answer-review-options-fixture.ts";
import {
  packedAuditSources,
  packedTicketSources,
} from "./dependency-audit-template-fixture.ts";
import {
  packedPatrolSources,
  packedRescueSources,
} from "./rescue-template-options-fixture.ts";
import { packedTriageSources } from "./triage-template-fixture.ts";
import { packedGoalSources } from "./goal-template-fixture.ts";
import { packedDriftSources } from "./docs-drift-template-fixture.ts";
import { packedIdeaSources } from "./packed-idea-template.ts";

export const packedTemplateFiles = packedAnswerSources.concat(
  packedAuditSources,
  packedTicketSources,
  packedTemplateSources,
  packedDriftSources,
  packedGoalSources,
  packedIdeaSources,
  packedPatrolSources,
  packedRescueSources,
  packedReviewSources,
  packedTriageSources,
);
