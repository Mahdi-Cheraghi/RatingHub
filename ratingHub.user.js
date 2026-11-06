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

    const ICONS = {
        metacritic: `
            <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none">
                <circle cx="12" cy="12" r="11" fill="#FFCC33"/>
                <path d="M6 16.5V7.5H8.2L12 12.2L15.8 7.5H18V16.5H15.8V11L12.7 14.8H11.3L8.2 11V16.5H6Z" fill="#000000"/>
            </svg>
        `,
        popcorn: `
            <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none">
                <path d="M5.5 9.5L7 21H17L18.5 9.5H5.5Z" fill="#E52D27"/>
                <path d="M8.5 9.5L9.5 21M14.5 9.5L13.5 21" stroke="#FFFFFF" stroke-width="1.2"/>
                <circle cx="7" cy="7.5" r="2.8" fill="#FDD835"/>
                <circle cx="12" cy="6" r="3.2" fill="#FFF59D"/>
                <circle cx="17" cy="7.5" r="2.8" fill="#FDD835"/>
                <circle cx="9.5" cy="8" r="2.2" fill="#FFF59D"/>
                <circle cx="14.5" cy="8" r="2.2" fill="#FDD835"/>
            </svg>
        `,
        tomatoes: `
            <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none">
                <path d="M12 4C7.5 4 3.5 7.5 3.5 12.5C3.5 17.5 7.5 21 12 21C16.5 21 20.5 17.5 20.5 12.5C20.5 7.5 16.5 4 12 4Z" fill="#FA320A"/>
                <path d="M12 2C12.5 3.5 13.5 4.5 15.5 4.5C14 5.5 13.2 6.5 13 8C12.2 6.5 11 5.8 9.5 6C10.5 5 11.2 3.8 12 2Z" fill="#2E7D32"/>
                <path d="M12 4.5C13 3.5 15 3.2 16.5 3C15.5 4 14.8 5 14.5 6C15.8 6.5 17 6.2 18 6C16.8 7 15.5 7.2 14.2 7.2" stroke="#2E7D32" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
        `,
        letterboxd: `
            <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none">
                <circle cx="12" cy="12" r="11" fill="#14181C"/>
                <circle cx="8" cy="12" r="3.2" fill="#FF8000"/>
                <circle cx="16" cy="12" r="3.2" fill="#40BCF4"/>
                <circle cx="12" cy="12" r="3.2" fill="#00E054"/>
                <path d="M10.2 10.2C10.8 10.8 11.2 11.4 11.2 12C11.2 12.6 10.8 13.2 10.2 13.8C9.6 13.2 9.2 12.6 9.2 12C9.2 11.4 9.6 10.8 10.2 10.2Z" fill="#14181C" opacity="0.3"/>
                <path d="M13.8 10.2C14.4 10.8 14.8 11.4 14.8 12C14.8 12.6 14.4 13.2 13.8 13.8C13.2 13.2 12.8 12.6 12.8 12C12.8 11.4 13.2 10.8 13.8 10.2Z" fill="#14181C" opacity="0.3"/>
            </svg>
        `,
    };

    // Badge definitions. `aliases` covers the spellings the MDBList API uses
    // for the same source; `direct` marks services whose page link can be
    // resolved locally (null = fixed letterboxd imdb link, see resolver).
    const services = [
        {
            id: "tomatoes",
            name: "TOMATO",
            aliases: ["rtomatoes", "rottentomatoes", "tomatoes", "rt"],
            suffix: "%",
            icon: ICONS.tomatoes,
            direct: "rt",
        },
        {
            id: "popcorn",
            name: "POPCORN",
            aliases: [
                "rtaudience",
                "popcorn",
                "popcornmeter",
                "tomatoesaudience",
            ],
            suffix: "%",
            icon: ICONS.popcorn,
            direct: "rt",
        },
        {
            id: "metacritic",
            name: "META",
            aliases: ["metacritic", "metascore", "mc"],
            suffix: "",
            icon: ICONS.metacritic,
            direct: "mc",
        },
        {
            id: "letterboxd",
            name: "LETTER",
            aliases: ["letterrating", "letterboxd", "letter", "lb"],
            suffix: "/5",
            icon: ICONS.letterboxd,
            direct: null,
        },
    ];

    // --- API key -----------------------------------------------------------

    function getApiKey() {
        return GM_getValue(API_KEY_STORAGE, "").trim();
    }

    function configureApiKey() {
        const answer = prompt("Enter your MDBList API Key:", getApiKey());
        if (answer === null) return;

        const key = answer.trim();
        if (key && (key.length > 512 || /\s/.test(key))) {
            alert("Invalid API key format.");
            return;
        }

        GM_setValue(API_KEY_STORAGE, key);
        activeId = ""; // force a rebuild so the new key takes effect
        initialize(true);
    }

    GM_registerMenuCommand("Set MDBList API Key", configureApiKey);
    GM_registerMenuCommand("Refresh Ratings", () => {
        activeId = "";
        initialize(true);
    });
})();
