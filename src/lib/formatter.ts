import { CAST_CHAR_LIMIT, FEVER_TEAM_TRICODE } from "./config";
import type { FeverStandings } from "./wnba";

export interface BoxscorePlayer {
  status: string;
  firstName: string;
  familyName: string;
  statistics: {
    points: number | string;
    reboundsTotal: number | string;
    assists: number | string;
    steals: number | string;
    blocks: number | string;
    fieldGoalsMade: number | string;
    fieldGoalsAttempted: number | string;
    freeThrowsMade: number | string;
    freeThrowsAttempted: number | string;
    turnovers: number | string;
  };
}

interface FormatRecapCastArgs {
  homeTricode: string;
  awayTricode: string;
  /** Short team name only (e.g. "Fever", "Valkyries"). */
  homeShortName: string;
  awayShortName: string;
  homeScore: number;
  awayScore: number;
  /** Fever's full active player roster from the boxscore. */
  feverPlayers: BoxscorePlayer[];
  /** Fever team standings; null if standings fetch failed. */
  standings: FeverStandings | null;
  /**
   * Recap watch-page URL. Only passed on the non-video image fallback, where it
   * is appended as a clickable line so users can still reach the video on
   * wnba.com. Omitted for native-video casts (the video itself is the embed).
   */
  recapWatchUrl?: string;
}

function n(v: number | string): number {
  const x = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(x) ? Number(x) : 0;
}

/** NBA Efficiency: (PTS+REB+AST+STL+BLK) − ((FGA−FGM)+(FTA−FTM)+TOV). */
function efficiency(p: BoxscorePlayer): number {
  const s = p.statistics;
  return (
    n(s.points) + n(s.reboundsTotal) + n(s.assists) + n(s.steals) + n(s.blocks)
    - ((n(s.fieldGoalsAttempted) - n(s.fieldGoalsMade))
       + (n(s.freeThrowsAttempted) - n(s.freeThrowsMade))
       + n(s.turnovers))
  );
}

function pickTopPerformers(players: BoxscorePlayer[], count = 2): BoxscorePlayer[] {
  return players
    .filter((p) => p.status === "ACTIVE")
    .map((p) => ({ p, eff: efficiency(p) }))
    .sort((a, b) => b.eff - a.eff)
    .slice(0, count)
    .map((x) => x.p);
}

function formatPerformerLine(p: BoxscorePlayer): string {
  const s = p.statistics;
  return `${p.firstName} ${p.familyName}: ${n(s.points)} PTS, ${n(s.reboundsTotal)} REB, ${n(s.assists)} AST`;
}

const ORDINAL_SUFFIX: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${ORDINAL_SUFFIX[n % 10] ?? "th"}`;
}

/**
 * Format the cast body for a final Indiana Fever recap.
 *
 * Layout:
 *   🏀 FINAL: Fever 90, Valkyries 82
 *
 *   🏆 Top performers
 *   1️⃣ Aliyah Boston: 20 PTS, 16 REB, 3 AST
 *   2️⃣ Caitlin Clark: 22 PTS, 2 REB, 9 AST
 *
 *   📋 Record/streak/rank: 4-2 (0.667) / W3 / 2nd in E. Conference
 *
 * The Fever are always listed first in the score line — this is a Fever
 * channel bot, so the perspective is fixed even on a loss. The top-performers
 * and standings sections are each omitted gracefully if their data is missing.
 */
export function formatRecapCast(args: FormatRecapCastArgs): string {
  const { homeTricode, homeShortName, awayShortName, homeScore, awayScore, feverPlayers, standings, recapWatchUrl } = args;

  const feverIsHome = homeTricode === FEVER_TEAM_TRICODE;
  const feverShort = feverIsHome ? homeShortName : awayShortName;
  const oppShort = feverIsHome ? awayShortName : homeShortName;
  const feverScore = feverIsHome ? homeScore : awayScore;
  const oppScore = feverIsHome ? awayScore : homeScore;

  const sections: string[] = [];
  sections.push(`🏀 FINAL: ${feverShort} ${feverScore}, ${oppShort} ${oppScore}`);

  const top = pickTopPerformers(feverPlayers, 2);
  if (top.length >= 1) {
    const lines = ["🏆 Top performers"];
    if (top[0]) lines.push(`1️⃣ ${formatPerformerLine(top[0])}`);
    if (top[1]) lines.push(`2️⃣ ${formatPerformerLine(top[1])}`);
    sections.push(lines.join("\n"));
  }

  if (standings) {
    const pct = standings.winPct.toFixed(3).replace(/^0/, "0"); // "0.667"
    sections.push(
      `📋 Record/streak/rank: ${standings.record} (${pct}) / ${standings.currentStreak} / ${ordinal(standings.conferenceRank)} in ${standings.conferenceLabel}`
    );
  }

  // Image-fallback only: give users a way to reach the video. The URL goes in
  // the body (a link), never as the embed — the wnba.com/watch SPA has no
  // og:video and renders as an empty card if embedded.
  if (recapWatchUrl) {
    sections.push(`▶️ Watch recap: ${recapWatchUrl}`);
  }

  const text = sections.join("\n\n");
  if (text.length <= CAST_CHAR_LIMIT) return text;
  return text.slice(0, CAST_CHAR_LIMIT - 1) + "…";
}

/**
 * Format a Fever news cast from an ESPN article. The article URL itself
 * is passed as the embed (Farcaster unfurls ESPN URLs into a card with
 * the headline image), so the body keeps the headline + an attribution
 * line and lets the embed carry the visual weight.
 */
export function formatNewsCast(
  headline: string,
  byline: string | undefined,
  url: string
): string {
  const trail = byline ? `✍️ ${byline} | Read more \u{1F447}` : `Read more \u{1F447}`;
  const text = `\u{1F4E3} Fever news: ${headline}\n\n${trail}`;
  if (text.length <= CAST_CHAR_LIMIT) return text;
  const room = CAST_CHAR_LIMIT - (trail.length + "📣 Fever news: \n\n".length + 1);
  return `\u{1F4E3} Fever news: ${headline.slice(0, room)}…\n\n${trail}`;
}
