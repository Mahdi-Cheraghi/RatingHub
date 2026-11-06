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
})();
