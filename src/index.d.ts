/**
 * HowLongToBeat Client
 * A robust client for the HowLongToBeat API that automatically captures the
 * dynamic credentials the site requires (auth token + rotating key/value pair)
 * to ensure reliable access to HLTB data.
 * 
 * @author JavocSoft (https://javocsoft.com)
 * @license MIT
 */

declare class HLTBClient {
  /**
   * Creates a new HowLongToBeat client
   * @param options - Configuration options
   */
  constructor(options?: HLTBClientOptions);

  /**
   * Whether the service is enabled
   */
  enabled: boolean;

  /**
   * Base URL for HowLongToBeat
   */
  baseUrl: string;

  /**
   * Search route used against HowLongToBeat (e.g. "/api/search/site")
   */
  searchPath: string;

  /**
   * User-Agent used both to capture credentials and to replay requests.
   * It is embedded in the auth token, so it must not differ between the two.
   */
  userAgent: string;

  /**
   * How long to cache credentials (in minutes)
   */
  cacheMinutes: number;

  /**
   * How long to stop relaunching the browser after a failed capture (in minutes)
   */
  failureCooldownMinutes: number;

  /**
   * Searches for a game on HowLongToBeat
   * @param gameName - Name of the game to search
   * @returns Array of search results or null on error
   */
  searchGame(gameName: string): Promise<HLTBSearchResult[] | null>;

  /**
   * Gets the completion duration for a game
   * @param gameName - Name of the game (must match exactly, case-insensitive)
   * @returns Duration data or null if not found
   */
  getGameDuration(gameName: string): Promise<HLTBDuration | null>;

  /**
   * Converts seconds to hours
   * @param seconds - Time in seconds
   * @returns Hours with 2 decimal places, or null if invalid
   */
  secondsToHours(seconds: number): number | null;

  /**
   * Formats hours to a human-readable string
   * @param hours - Hours as decimal
   * @returns Formatted string like "12h 30m", or null if invalid
   */
  formatDuration(hours: number): string | null;

  /**
   * Cleans up resources (closes Puppeteer browser if open)
   */
  destroy(): Promise<void>;
}

interface HLTBClientOptions {
  /**
   * How long to cache credentials (in minutes)
   * @default 30
   */
  cacheMinutes?: number;

  /**
   * How long to stop relaunching the browser after a failed capture (in minutes).
   * Prevents a broken HLTB site from spawning a browser on every lookup.
   * @default 30
   */
  failureCooldownMinutes?: number;

  /**
   * Enable/disable the service
   * @default true
   */
  enabled?: boolean;

  /**
   * User-Agent used to capture credentials and to replay requests.
   * The auth token embeds it, so both must match.
   */
  userAgent?: string;
}

interface HLTBDuration {
  /**
   * HLTB game ID (useful for building URLs)
   */
  gameId: number;

  /**
   * Main story completion time in hours
   */
  mainStory: number | null;

  /**
   * Main story + extras completion time in hours
   */
  mainExtras: number | null;

  /**
   * 100% completion time in hours
   */
  completionist: number | null;
}

interface HLTBSearchResult {
  /**
   * HLTB game ID
   */
  game_id: number;

  /**
   * Game name
   */
  game_name: string;

  /**
   * Alternative and regional titles, comma separated
   */
  game_alias: string;

  /**
   * Game type (e.g., "game", "dlc")
   */
  game_type: string;

  /**
   * Game image filename
   */
  game_image: string;

  /**
   * Main story completion time in seconds. 0 means "no data", not "0 hours".
   */
  comp_main: number;

  /**
   * Main + extras completion time in seconds
   */
  comp_plus: number;

  /**
   * 100% completion time in seconds
   */
  comp_100: number;

  /**
   * Average completion time in seconds
   */
  comp_all: number;

  /**
   * Number of players who submitted data
   */
  count_comp: number;

  /**
   * Release year
   */
  release_world: number;
}

export = HLTBClient;
