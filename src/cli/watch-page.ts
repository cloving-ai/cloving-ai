import {
  calendarText,
  dayText,
  loopText,
  scheduleStatusLine,
  scheduledText,
  shownScheduled,
} from "./schedule-render.ts";
import {
  LoopActions,
  LoopCell,
  LoopLast,
  lastRunText,
  loopLastText,
  loopMessage,
  loopTime,
  pastClock,
} from "./watch-loops-view.ts";
import { LineNext, nextRunText } from "./watch-line-next-view.ts";
import * as waitDisplay from "./command-waits.ts";
import { cardReply } from "./watch-card-reply.ts";
import { record } from "../protocol.ts";
import { Commands, commandText } from "./command-effects.ts";
import { watchCardClient } from "./watch-card-client.ts";
import {
  AddCard,
  CardInput,
  cardKey,
  cardSubmitKey,
} from "./watch-card-view.ts";
import { watchClient } from "./watch-client.ts";
import { watchDecisionClient } from "./watch-decision-client.ts";
import { watchLoopsClient } from "./watch-loops-client.ts";
import { watchTranscriptClient } from "./watch-transcript-client.ts";
import { transcriptFunctions } from "./watch-transcript-view.ts";
import { RunNotes } from "./watch-notes-view.ts";
import { runActionFunctions } from "./watch-rename-view.ts";
import { runCommandFunctions } from "./watch-run-command-view.ts";
import { watchRunCommandClient } from "./watch-run-command-client.ts";
import { watchPhoneClient } from "./watch-phone-client.ts";
import {
  PhoneAsk,
  PhoneCode,
  PhoneList,
  PhonePanel,
  phoneButton,
  phoneNotices,
  refusalText,
  timeLeft,
} from "./watch-phone-view.ts";
import { priceOf, tokenCount, usageOf } from "../worker-usage.ts";
import {
  continuedCostText,
  priceText,
  queueSpendLines,
  spendLimitText,
  usageText,
  attemptText,
  totalsSuffix,
} from "./usage-render.ts";
import { watchStyle } from "./watch-page-style.ts";
import { artStyle } from "./watch-art-style.ts";
import { transcriptStyle } from "./watch-transcript-style.ts";
import type { WatchThemes } from "./watch-themes.ts";
import {
  countText,
  labelWord,
  noThemes,
  shownTheme,
  themeName,
  themeReason,
  ThemeMenu,
  ThemeNotice,
  wordText,
} from "./watch-theme-view.ts";
import {
  Floor,
  Legend,
  Line,
  LineEnd,
  Lines,
  ReadyCount,
  RepositoryLines,
  Station,
  Token,
  lampLabel,
  stepAge,
} from "./watch-floor-view.ts";
import { Demo, Shelf, Tile } from "./watch-shelf-view.ts";
import { needsFunctions } from "./watch-needs-view.ts";
import { decisionFunctions } from "./watch-decision-view.ts";
import {
  DayChart,
  LaneLine,
  RepositoryTable,
  Today,
  TodayNumber,
  TodayNumbers,
  WorkflowTable,
  dollars,
  spentText,
  unknownCostText,
} from "./watch-today-view.ts";
import {
  Board,
  Card,
  HandoffLinks,
  Column,
  columnCollapsed,
  CardReview,
  cardReview,
  cardStep,
  cardTotals,
  completionMark,
  observationText,
  staleObservation,
} from "./watch-board-view.ts";
import {
  boardWorkflow,
  locationOptions,
  watchHash,
  watchLocation,
  watchTitle,
} from "./watch-navigation.ts";
import {
  clockTime,
  completedDetail,
  counted,
  elapsed,
  groupActivity,
  pageTitle,
  phaseTime,
  runName,
  runTone,
  selectedRun,
  toneOf,
  turnTime,
  waitingDetail,
} from "./watch-render.ts";
import { turnFunctions } from "./watch-turn.ts";
import {
  Banner,
  BannerDetail,
  BoardPage,
  FloorPage,
  Page,
  Phases,
  Run,
  RunTotals,
} from "./watch-view.ts";
import {
  BackLink,
  BannerBack,
  Brand,
  clove,
  Header,
  HeaderActions,
  HeaderCounts,
  HeaderStatus,
  QueueControl,
  Queue,
  queueLanes,
  RefusedWorkflows,
  skippedText,
  Version,
} from "./watch-header-view.ts";

const functions = [
  scheduleStatusLine,
  calendarText,
  dayText,
  scheduledText,
  shownScheduled,
  loopText,
  loopTime,
  pastClock,
  lastRunText,
  loopLastText,
  loopMessage,
  LoopActions,
  LoopLast,
  LoopCell,
  record,
  commandText,
  Commands,
  waitDisplay.CommandWaits,
  waitDisplay.commandWaitText,
  waitDisplay.effectBudgetText,
  themeName,
  themeReason,
  shownTheme,
  wordText,
  countText,
  labelWord,
  ThemeMenu,
  ThemeNotice,
  queueLanes,
  skippedText,
  Queue,
  Brand,
  HeaderCounts,
  HeaderStatus,
  QueueControl,
  HeaderActions,
  Version,
  cardReply,
  cardSubmitKey,
  cardKey,
  AddCard,
  CardInput,
  priceOf,
  tokenCount,
  usageOf,
  priceText,
  continuedCostText,
  queueSpendLines,
  spendLimitText,
  usageText,
  attemptText,
  totalsSuffix,
  watchHash,
  locationOptions,
  watchLocation,
  boardWorkflow,
  watchTitle,
  cardReview,
  cardStep,
  cardTotals,
  completionMark,
  observationText,
  staleObservation,
  CardReview,
  Card,
  HandoffLinks,
  RunNotes,
  ...runActionFunctions,
  ...runCommandFunctions,
  Column,
  columnCollapsed,
  Board,
  lampLabel,
  stepAge,
  nextRunText,
  Token,
  Station,
  ReadyCount,
  LineNext,
  LineEnd,
  Legend,
  Line,
  Lines,
  RepositoryLines,
  Floor,
  Demo,
  Tile,
  Shelf,
  ...needsFunctions,
  dollars,
  spentText,
  unknownCostText,
  TodayNumber,
  TodayNumbers,
  DayChart,
  WorkflowTable,
  RepositoryTable,
  LaneLine,
  Today,
  counted,
  elapsed,
  clockTime,
  groupActivity,
  turnTime,
  toneOf,
  runTone,
  runName,
  waitingDetail,
  completedDetail,
  phaseTime,
  selectedRun,
  pageTitle,
  ...turnFunctions,
  ...decisionFunctions,
  ...transcriptFunctions,
  BannerDetail,
  Banner,
  Phases,
  Run,
  RunTotals,
  timeLeft,
  refusalText,
  phoneButton,
  phoneNotices,
  PhoneCode,
  PhoneAsk,
  PhoneList,
  PhonePanel,
  Header,
  RefusedWorkflows,
  BackLink,
  BannerBack,
  FloorPage,
  BoardPage,
  Page,
];

function scriptData(value: WatchThemes): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function pageDocument(
  actionToken: string | null = null,
  themes: WatchThemes = noThemes,
): string {
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${clove.viewBox}">${clove.paths.map((d) => `<path fill="#0BBF64" d="${d}"/>`).join("")}</svg>`;
  const script = [
    'import { h as element, h as component, render } from "./preact.mjs";',
    `const clove = ${JSON.stringify(clove)};`,
    `const actionToken = ${JSON.stringify(actionToken)};`,
    `const themes = ${scriptData(themes)};`,
    ...functions.map((item) => item.toString()),
    watchCardClient,
    watchPhoneClient,
    watchLoopsClient,
    watchRunCommandClient,
    watchTranscriptClient,
    watchDecisionClient,
    watchClient,
  ].join("\n");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cloving</title>',
    `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`,
    `<style>${watchStyle}${artStyle}${transcriptStyle}</style><style id="theme-style">${themes.style}</style></head><body>`,
    '<div id="app"></div>',
    `<script type="module">${script}</script></body></html>`,
    "",
  ].join("\n");
}
