// ==UserScript==
// @name          RatingHub
// @namespace     local.imdb.mdblist
// @version       1.0.4
// @description   Display external ratings inline with IMDb rating
// @match         https://www.imdb.com/title/*
// @run-at        document-idle
// @grant         GM_getValue
// @grant         GM_setValue
// @grant         GM_registerMenuCommand
// @grant         GM_xmlhttpRequest
// @connect       api.mdblist.com
// @connect       www.rottentomatoes.com
// @connect       www.metacritic.com
// ==/UserScript==

/*
 * RatingHub
 *
 * Shows Rotten Tomatoes (critic + audience), Metacritic and Letterboxd
 * ratings next to IMDb's own rating on title pages. Scores come from
 * MDBList, so an API key is required (Tampermonkey menu -> "Set MDBList
 * API Key").
 *
 * Direct RT/Metacritic links are resolved by fetching the guessed page and
 * verifying it against its og:title; verified links are cached for a day,
 * while search fallbacks only stick for an hour so misses get retried.
 */

(() => {
    "use strict";

    // MDBList API base and GM storage layout: ratings cached per title,
    // plus a per-service cache for resolved direct links. Failed lookups
    // only stick an hour so a temporary RT/Metacritic hiccup doesn't pin
    // the badge to its search link for a whole day.
    const API_BASE = "https://api.mdblist.com";
    const API_KEY_STORAGE = "mdblist_api_key";

    const RATING_CACHE_PREFIX = "mdblist_rating_";
    const RATING_CACHE_TTL = 6 * 60 * 60 * 1000;

    const LINK_CACHE_PREFIX = "mdblist_link_";
    const LINK_TTL_OK = 24 * 60 * 60 * 1000;
    const LINK_TTL_FAIL = 1 * 60 * 60 * 1000;

    const DEBUG = true;

    // IMDb id currently rendered by the mounted UI, and which layout slot
    // ('desktop' or 'mobile') it was built for.
    let activeId = "";
    let activeMountType = "";

    let observer = null;
    let resizeTimer = 0;

    // Bumped on every rebuild; async responses compare against it so a slow
    // reply for a title we already navigated away from never repaints.
    let requestToken = 0;

    // The shadow root is closed, so this reference is the only way back into
    // it once the host is in the document (link resolution needs it).
    let activeUI = null;

    function log(...args) {
        if (DEBUG) console.log("[MDBList]", ...args);
    }
})();
