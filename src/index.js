const axios = require('axios');
const puppeteer = require('puppeteer');

/**
 * HowLongToBeat Client
 *
 * A robust client for the HowLongToBeat API that automatically captures the
 * dynamic credentials the site requires (auth token + per-day key/value pair)
 * with Puppeteer, then reuses them over plain HTTP.
 *
 * @author JavocSoft (https://javocsoft.com)
 * @license MIT
 *
 * API endpoint:
 * - POST https://howlongtobeat.com/api/search/site
 *
 * The endpoint requires three headers captured from a real page load:
 * - x-auth-token: base64 blob that embeds the client IP and User-Agent
 * - x-hp-key:     the key of the day (e.g. "ign_0686331a"), it rotates
 * - x-hp-val:     the value that goes with it (16 hex chars)
 *
 * The same value must also be sent inside the body, in a property whose NAME
 * is the key of the day (body[hpKey] = hpValue). Without it the API answers
 * 404; without x-hp-val it answers 403.
 *
 * Because the token embeds the IP and the User-Agent, it cannot be forged and
 * it must be replayed with the exact same User-Agent used to capture it.
 *
 * Response time format:
 * - comp_main: Main Story time (in seconds)
 * - comp_plus: Main + Extras time (in seconds)
 * - comp_100: Completionist time (in seconds)
 *
 * Conversion: divide by 3600 to get hours. A 0 means "no data", not "0 hours".
 */

const BASE_URL = 'https://howlongtobeat.com';

/** Search route. HLTB has moved it several times; see README if it 404s. */
const SEARCH_PATH = '/api/search/site';

/** Must be identical when capturing and when replaying: it is inside the token. */
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_CACHE_MINUTES = 30;
const DEFAULT_FAILURE_COOLDOWN_MINUTES = 30;

/** Statuses that mean "stale credentials", the only ones worth a recapture. */
const STALE_CREDENTIAL_STATUSES = [401, 403, 404];

const CAPTURE_NAVIGATION_TIMEOUT_MS = 30000;
const CAPTURE_WAIT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 15000;

class HLTBClient {
  /**
   * Creates a new HowLongToBeat client
   * @param {Object} options - Configuration options
   * @param {number} options.cacheMinutes - How long to cache credentials (default: 30)
   * @param {number} options.failureCooldownMinutes - How long to stop relaunching the
   *   browser after a failed capture (default: 30)
   * @param {boolean} options.enabled - Enable/disable the service (default: true)
   * @param {string} options.userAgent - User-Agent used to capture and to replay
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.baseUrl = BASE_URL;
    this.searchPath = SEARCH_PATH;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.cacheMinutes = options.cacheMinutes || DEFAULT_CACHE_MINUTES;
    this.failureCooldownMinutes = options.failureCooldownMinutes || DEFAULT_FAILURE_COOLDOWN_MINUTES;

    /** @type {{authToken: string, hpKey: string, hpValue: string}|null} */
    this.credentials = null;
    this.credentialsExpiry = null;

    /** Negative cache: a capture that just failed will not work seconds later. */
    this.failureUntil = null;

    this.browser = null;
  }

  /**
   * Opens a headless browser, lets the page perform its own search request and
   * keeps the credentials it used.
   * @returns {Promise<{authToken: string, hpKey: string, hpValue: string}|null>}
   * @private
   */
  async _captureCredentials() {
    let browser = null;

    try {
      console.log('[HLTB] Launching headless browser to capture credentials...');

      browser = await puppeteer.launch({
        // Since puppeteer 22, `true` IS the new headless mode.
        // The 'new' string was deprecated and later removed.
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ]
      });
      this.browser = browser;

      const page = await browser.newPage();
      await page.setUserAgent(this.userAgent);

      let captured = null;
      let onCaptured = null;
      const capturedPromise = new Promise((resolve) => { onCaptured = resolve; });

      page.on('request', (request) => {
        if (captured) return;
        if (request.method() !== 'POST') return;
        if (!request.url().startsWith(`${this.baseUrl}${this.searchPath}`)) return;

        const headers = request.headers();
        const authToken = headers['x-auth-token'];
        const hpKey = headers['x-hp-key'];
        if (!authToken || !hpKey) return;

        // The same value travels as a header and as a body field named after the key
        let hpValue = headers['x-hp-val'] || null;
        if (!hpValue) {
          try {
            hpValue = JSON.parse(request.postData() || '{}')[hpKey] || null;
          } catch (error) {
            hpValue = null;
          }
        }

        if (hpValue) {
          captured = { authToken, hpKey, hpValue };
          onCaptured();
        }
      });

      // Any term works: what matters is the request the page fires because of it
      await page.goto(`${this.baseUrl}/?q=zelda`, {
        waitUntil: 'domcontentloaded',
        timeout: CAPTURE_NAVIGATION_TIMEOUT_MS
      });

      // The site debounces the search ~1s, so wait for the request itself
      // instead of a fixed sleep, and give up if it never arrives
      await this._waitFor(capturedPromise, CAPTURE_WAIT_TIMEOUT_MS);

      if (captured) {
        console.log(`[HLTB] ✓ Credentials captured (key: ${captured.hpKey})`);
      } else {
        console.warn('[HLTB] ⚠️ No search request was seen; HLTB may have moved the route again '
          + `(expected POST ${this.baseUrl}${this.searchPath})`);
      }

      return captured;

    } catch (error) {
      console.error('[HLTB] Error capturing credentials:', error.message);
      return null;
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
      if (this.browser === browser) {
        this.browser = null;
      }
    }
  }

  /**
   * Resolves when `promise` settles or when the timeout elapses, whichever
   * comes first, without leaving a pending timer behind.
   * @param {Promise<any>} promise
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   * @private
   */
  async _waitFor(promise, timeoutMs) {
    let timer = null;
    try {
      await Promise.race([
        promise,
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Returns valid credentials, capturing them if needed.
   * Does not insist when a capture has just failed: launching a browser to find
   * out again is exactly what melts small servers when HLTB changes its site.
   * @param {boolean} force - Ignore the cached credentials and capture new ones
   * @returns {Promise<{authToken: string, hpKey: string, hpValue: string}|null>}
   * @private
   */
  async _getCredentials(force = false) {
    const valid = this.credentials && this.credentialsExpiry && Date.now() < this.credentialsExpiry;
    if (valid && !force) {
      console.log('[HLTB] Using cached credentials');
      return this.credentials;
    }

    if (this.failureUntil && Date.now() < this.failureUntil) {
      return null;
    }

    const captured = await this._captureCredentials();

    if (captured) {
      this.credentials = captured;
      this.credentialsExpiry = Date.now() + (this.cacheMinutes * 60 * 1000);
      this.failureUntil = null;
      console.log(`[HLTB] ✓ Credentials cached until: ${new Date(this.credentialsExpiry).toLocaleString()}`);
    } else {
      this.credentials = null;
      this.credentialsExpiry = null;
      this.failureUntil = Date.now() + (this.failureCooldownMinutes * 60 * 1000);
      // Warn once, when the breaker opens, not on every search that finds it open
      console.warn('[HLTB] Capture failed; not retrying until '
        + new Date(this.failureUntil).toLocaleTimeString());
    }

    return this.credentials;
  }

  /**
   * Builds the search body. The last property is named after the key of the day.
   * @param {string} gameName - Name of the game
   * @param {{hpKey: string, hpValue: string}} credentials - Captured credentials
   * @returns {Object}
   * @private
   */
  _buildPayload(gameName, credentials) {
    return {
      searchType: 'games',
      searchTerms: gameName.trim().toLowerCase().split(/\s+/),
      searchPage: 1,
      size: 20,
      searchOptions: {
        games: {
          userId: 0,
          platform: '',
          sortCategory: 'popular',
          rangeCategory: 'main',
          rangeTime: {
            min: null,
            max: null
          },
          gameplay: {
            perspective: '',
            flow: '',
            genre: '',
            difficulty: ''
          },
          rangeYear: {
            min: '',
            max: ''
          },
          modifier: ''
        },
        users: {
          sortCategory: 'postcount'
        },
        lists: {
          sortCategory: 'follows'
        },
        filter: '',
        sort: 0,
        randomizer: 0
      },
      useCache: true,
      [credentials.hpKey]: credentials.hpValue // without this: 404
    };
  }

  /**
   * Builds the request headers.
   * @param {{authToken: string, hpKey: string, hpValue: string}} credentials
   * @returns {Object}
   * @private
   */
  _buildHeaders(credentials) {
    return {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent, // must be the one baked into the token
      'Referer': `${this.baseUrl}/`,
      'Origin': this.baseUrl,
      'x-auth-token': credentials.authToken,
      'x-hp-key': credentials.hpKey,
      'x-hp-val': credentials.hpValue // without this: 403
    };
  }

  /**
   * Searches for a game on HowLongToBeat.
   * Stale credentials are retried exactly once with a fresh capture, which is
   * the same policy the site itself follows on a 403.
   * @param {string} gameName - Name of the game to search
   * @returns {Promise<Array|null>} - Array of search results or null on error
   */
  async searchGame(gameName) {
    try {
      for (const force of [false, true]) {
        const credentials = await this._getCredentials(force);
        if (!credentials) {
          if (force) break;
          continue;
        }

        try {
          const response = await axios.post(
            `${this.baseUrl}${this.searchPath}`,
            this._buildPayload(gameName, credentials),
            { headers: this._buildHeaders(credentials), timeout: REQUEST_TIMEOUT_MS }
          );

          const results = response.data.data || [];
          console.log(`[HLTB] ✓ Search successful, found ${results.length} results`);
          return results;

        } catch (error) {
          const status = error.response?.status;

          // Only stale credentials deserve a retry; anything else is a real error
          if (force || !status || !STALE_CREDENTIAL_STATUSES.includes(status)) {
            throw error;
          }

          console.log(`[HLTB] Search failed with ${status}, refreshing credentials and retrying once...`);
        }
      }

      console.error('[HLTB] Could not obtain HowLongToBeat credentials');
      return null;

    } catch (error) {
      console.error(`[HLTB] Error searching game: ${error.message} `
        + `- URL: ${this.baseUrl}${this.searchPath}`);
      return null;
    }
  }

  /**
   * Converts seconds to hours
   * Times from HLTB API are in seconds
   * @param {number} seconds - Time in seconds
   * @returns {number|null} - Hours with 2 decimal places, or null if invalid
   */
  secondsToHours(seconds) {
    if (!seconds || seconds <= 0) return null;
    const hours = seconds / 3600;
    return Math.round(hours * 100) / 100;
  }

  /**
   * Formats hours to a human-readable string
   * @param {number} hours - Hours as decimal
   * @returns {string|null} - Formatted string like "12h 30m", or null if invalid
   */
  formatDuration(hours) {
    if (!hours || hours <= 0) return null;

    const wholeHours = Math.floor(hours);
    const minutes = Math.round((hours - wholeHours) * 60);

    if (minutes === 0) {
      return `${wholeHours}h`;
    }

    return `${wholeHours}h ${minutes}m`;
  }

  /**
   * Checks whether a result matches the searched name, either by its name or by
   * one of its aliases (HLTB stores alternative and regional titles there).
   * @param {Object} game - A search result
   * @param {string} searchName - Searched name, already trimmed and lowercased
   * @returns {boolean}
   * @private
   */
  _matchesAlias(game, searchName) {
    const alias = (game.game_alias || '').trim().toLowerCase();
    if (!alias) return false;
    return alias.split(',').some(part => part.trim() === searchName);
  }

  /**
   * Gets the completion duration for a game from HowLongToBeat
   * @param {string} gameName - Name of the game (must match exactly, case-insensitive)
   * @returns {Promise<{gameId: number, mainStory: number, mainExtras: number, completionist: number}|null>}
   */
  async getGameDuration(gameName) {
    if (!this.enabled) {
      console.log('[HLTB] Service disabled');
      return null;
    }

    try {
      if (!gameName || typeof gameName !== 'string') {
        console.log('[HLTB] Invalid game name provided');
        return null;
      }

      console.log(`[HLTB] Getting duration for: ${gameName}`);

      const results = await this.searchGame(gameName);

      if (!results || results.length === 0) {
        console.log(`[HLTB] No results found for: ${gameName}`);
        return null;
      }

      // Log top results for debugging
      console.log(`[HLTB] Top 3 results:`, results.slice(0, 3).map(r => ({
        id: r.game_id,
        name: r.game_name,
        type: r.game_type,
        main: this.secondsToHours(r.comp_main),
        plus: this.secondsToHours(r.comp_plus),
        complete: this.secondsToHours(r.comp_100)
      })));

      // Find exact match (case-insensitive), preferring the name over an alias
      const searchName = gameName.trim().toLowerCase();
      const exactMatch = results.find(game => (game.game_name || '').trim().toLowerCase() === searchName)
        || results.find(game => this._matchesAlias(game, searchName));

      if (!exactMatch) {
        console.log(`[HLTB] No exact match found for: ${gameName}`);
        console.log(`[HLTB] Available results:`, results.slice(0, 5).map(r => r.game_name));
        return null;
      }

      console.log(`[HLTB] Exact match found: ${exactMatch.game_name} (ID: ${exactMatch.game_id})`);

      const durationData = {
        gameId: exactMatch.game_id,
        mainStory: this.secondsToHours(exactMatch.comp_main),
        mainExtras: this.secondsToHours(exactMatch.comp_plus),
        completionist: this.secondsToHours(exactMatch.comp_100)
      };

      // Validate that at least one time is available
      if (!durationData.mainStory && !durationData.mainExtras && !durationData.completionist) {
        console.log(`[HLTB] No duration data available for: ${exactMatch.game_name}`);
        return null;
      }

      console.log(`[HLTB] Duration data found:`, durationData);
      return durationData;

    } catch (error) {
      console.error('[HLTB] Error fetching game duration:', error);
      console.error('[HLTB] Error stack:', error.stack);
      return null;
    }
  }

  /**
   * Cleans up resources (closes Puppeteer browser if open)
   */
  async destroy() {
    if (this.browser) {
      try {
        await this.browser.close();
        this.browser = null;
        console.log('[HLTB] Browser closed');
      } catch (error) {
        console.error('[HLTB] Error closing browser:', error.message);
      }
    }
  }
}

module.exports = HLTBClient;
