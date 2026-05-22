import { CAST_CHAR_LIMIT } from "./config";

interface FormatRecapCastArgs {
  homeTricode: string;
  awayTricode: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  /** Whether the Indiana Fever played at home in this game. */
  isHome: boolean;
}

/**
 * Format the cast body for a final Indiana Fever recap.
 *
 * Output: "Final: Indiana Fever 90, Portland Fire 73 🏀"
 *   - Winner listed first.
 *   - Truncated to CAST_CHAR_LIMIT just in case of unusually long team names.
 *   - No date, no URL — the embed carries the video.
 */
export function formatRecapCast(args: FormatRecapCastArgs): string {
  const { homeName, awayName, homeScore, awayScore } = args;

  const homeWon = homeScore > awayScore;
  const winnerName = homeWon ? homeName : awayName;
  const winnerScore = homeWon ? homeScore : awayScore;
  const loserName = homeWon ? awayName : homeName;
  const loserScore = homeWon ? awayScore : homeScore;

  const text = `Final: ${winnerName} ${winnerScore}, ${loserName} ${loserScore} 🏀`;

  if (text.length <= CAST_CHAR_LIMIT) return text;
  return text.slice(0, CAST_CHAR_LIMIT - 1) + "…";
}
