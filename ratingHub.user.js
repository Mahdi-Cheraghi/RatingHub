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

    // --- Page info -----------------------------------------------------------

    function getIMDbId() {
        return location.pathname.match(/\/title\/(tt\d+)/)?.[1] || "";
    }

    function getTitleName() {
        const raw = document.querySelector(
            'h1[data-testid="hero__pageTitle"]',
        )?.textContent;
        return raw
            ? raw.trim()
            : document.title.replace(/- IMDb.*$/, "").trim();
    }

    // Movie vs. series decides which RT/Metacritic URL shape gets used.
    // IMDb ships this as ld+json, often split across several script blocks.
    function getMediaType() {
        for (const script of document.querySelectorAll(
            'script[type="application/ld+json"]',
        )) {
            try {
                const data = JSON.parse(script.textContent);
                const items = [
                    data,
                    ...(Array.isArray(data["@graph"]) ? data["@graph"] : []),
                ];

                for (const item of items) {
                    const types = Array.isArray(item["@type"])
                        ? item["@type"]
                        : [item["@type"]];
                    if (types.includes("Movie")) return "movie";
                    if (
                        types.some((type) =>
                            ["TVSeries", "TVMiniSeries"].includes(type),
                        )
                    )
                        return "show";
                }
            } catch {
                // Incomplete or non-JSON block; keep scanning
            }
        }
        return "movie";
    }

    // --- Text helpers --------------------------------------------------------

    const norm = (s) =>
        String(s || "")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");

    // Substring-tolerant on purpose: fetched pages decorate titles with
    // extra bits (years, network names) that shouldn't break the match.
    function titlesMatch(ours, page) {
        const a = norm(ours);
        const b = norm(page);
        if (!a || !b) return false;
        return a === b || b.startsWith(a) || a.startsWith(b);
    }

    function slugify(title, separator) {
        return String(title || "")
            .toLowerCase()
            .replace(/['’]/g, "")
            .replace(/[^a-z0-9]+/g, separator)
            .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, "g"), "");
    }

    // --- Networking -----------------------------------------------------------

    // Cross-origin page fetch through the userscript sandbox; used to verify
    // guessed RT/Metacritic URLs before we link to them.
    function fetchPage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                timeout: 12000,
                headers: { Accept: "text/html" },
                onload(response) {
                    if (response.status === 200 && response.responseText) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: () => reject(new Error("Network error.")),
                ontimeout: () => reject(new Error("Request timeout.")),
            });
        });
    }

    // --- Link resolution --------------------------------------------------------

    // og:title in either attribute order, with a <title> fallback.
    function extractOgTitle(html) {
        const match =
            html.match(
                /<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([\s\S]*?)["']/i,
            ) ||
            html.match(
                /<meta\s+[^>]*content=["']([\s\S]*?)["'][^>]*property=["']og:title["']/i,
            ) ||
            html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return match ? match[1].trim() : "";
    }

    // Guess the direct RT/Metacritic page for the title, then verify it via
    // its og:title. On any failure return a search URL instead; `ok` tells
    // the caller which one it is, and failed guesses are cached with the
    // short TTL in getCachedLink.
    async function resolveDirectLink(service, title, imdbId, type) {
        if (service.id === "letterboxd") {
            return { url: `https://letterboxd.com/imdb/${imdbId}/`, ok: true };
        }

        try {
            if (service.direct === "rt") {
                const part = type === "show" ? "tv" : "m";
                const page = `https://www.rottentomatoes.com/${part}/${slugify(title, "_")}`;
                const html = await fetchPage(page);
                // Strip "- Season N" so series pages still match the show.
                const og = extractOgTitle(html).replace(/\s*-\s*Season.*$/i, "");
                if (titlesMatch(title, og)) {
                    return { url: page, ok: true };
                }
            } else if (service.direct === "mc") {
                const part = type === "show" ? "tv" : "movie";
                const page = `https://www.metacritic.com/${part}/${slugify(title, "-")}`;
                const html = await fetchPage(page);
                if (titlesMatch(title, extractOgTitle(html))) {
                    return { url: page, ok: true };
                }
            }
        } catch {
            // Bad status, timeout or network error; use the search fallback
        }

        if (service.direct === "rt") {
            return {
                url: `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`,
                ok: false,
            };
        }
        return {
            url: `https://www.metacritic.com/search/${encodeURIComponent(title)}/?category=${type === "show" ? "2" : "13"}`,
            ok: false,
        };
    }

    function getCachedLink(service, imdbId) {
        const cached = GM_getValue(
            LINK_CACHE_PREFIX + service.id + imdbId,
            null,
        );
        if (!cached || typeof cached.url !== "string") return null;
        const ttl = cached.ok ? LINK_TTL_OK : LINK_TTL_FAIL;
        if (Date.now() - cached.time >= ttl) return null;
        return cached;
    }

    // --- Mount points -------------------------------------------------------

    function isVisible(el) {
        try {
            return !!el && el.getClientRects().length > 0;
        } catch {
            return false;
        }
    }

    // Desktop: IMDb's own rating bar is present, badges go just left of it.
    const DESKTOP_SELECTORS = [
        '[data-testid="hero-rating-bar__aggregate-rating"]',
    ];

    // Mobile has no rating bar; try the popularity/user-rating rows, then
    // the page title as the last visual anchor.
    const MOBILE_SELECTORS = [
        '[data-testid="hero-sub-nav-bar-popularity"]',
        'a[href*="/meter/"]',
        '[data-testid="hero-rating-bar__popularity__score"]',
        'button[data-testid="hero-rating-bar__user-rating__unrated"]',
        '[data-testid="hero-rating-bar__user-rating"]',
    ];

    function makeMount(anchor, type, where) {
        const parent = anchor?.parentNode;
        if (!anchor || !parent) return null;
        return {
            type,
            anchor,
            parent,
            insertMethod: (p, node, a) =>
                where === "append"
                    ? p.appendChild(node)
                    : p.insertBefore(node, a),
        };
    }

    function getMountPoint() {
        for (const selector of DESKTOP_SELECTORS) {
            const anchor = document.querySelector(selector);
            if (anchor && isVisible(anchor)) {
                return makeMount(anchor, "desktop", "before");
            }
        }

        for (const selector of MOBILE_SELECTORS) {
            const anchor = document.querySelector(selector);
            if (anchor && isVisible(anchor)) {
                return makeMount(anchor, "mobile", "append");
            }
        }

        const h1 = document.querySelector('h1[data-testid="hero__pageTitle"]');
        if (h1 && isVisible(h1)) {
            return makeMount(h1, "mobile", "append");
        }

        // Last resort: the element exists but is hidden (layout still
        // settling). Attach anyway instead of doing nothing, using the
        // aggregate-rating container to pick the layout slot.
        for (const selector of [...DESKTOP_SELECTORS, ...MOBILE_SELECTORS]) {
            const anchor = document.querySelector(selector);
            if (anchor && anchor.parentNode) {
                return makeMount(
                    anchor,
                    anchor.closest(
                        '[data-testid="hero-rating-bar__aggregate-rating"]',
                    )
                        ? "desktop"
                        : "mobile",
                    "append",
                );
            }
        }

        return null;
    }

    // --- UI ------------------------------------------------------------------

    // Closed shadow root keeps IMDb's styles out of the badges. Each badge
    // is an <a> pre-pointed at its best-known href (cached direct link or
    // search page) and filled in later by updateUI.
    function createUI(isMobile = false) {
        const host = document.createElement("div");
        host.id = "mdblist-inline-ratings";
        host.dataset.mode = isMobile ? "mobile" : "desktop";

        const shadow = host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");

        style.textContent = `
            :host {
                display: inline-flex;
                align-items: center;
                vertical-align: middle;
                font-family: Roboto, Helvetica, Arial, sans-serif;
                z-index: 20;
            }

            .ratings {
                display: flex;
                align-items: center;
                white-space: nowrap;
            }

            /* Desktop (above 1024px) */
            :host([data-mode="desktop"]) .ratings {
                gap: 16px;
                margin-right: 12px;
            }

            :host([data-mode="desktop"]) .item {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                text-decoration: none;
                cursor: pointer;
                padding: 4px 6px;
                border-radius: 6px;
                min-height: 50px;
                transition: background-color 0.15s ease-in-out;
            }

            :host([data-mode="desktop"]) .label {
                font-size: 11px;
                line-height: 14px;
                font-weight: 600;
                letter-spacing: 0.08em;
                color: rgba(255, 255, 255, 0.7);
                text-transform: uppercase;
                margin-bottom: 3px;
            }

            :host([data-mode="desktop"]) .score-row {
                display: flex;
                align-items: center;
                justify-content: center;
                height: 28px;
                gap: 6px;
            }

            :host([data-mode="desktop"]) .icon-wrapper {
                width: 22px;
                height: 22px;
            }

            :host([data-mode="desktop"]) .score-val {
                font-size: 18px;
                font-weight: 600;
                color: #ffffff;
            }

            /* Mobile and below 1024px (compact row next to Popularity) */
            :host([data-mode="mobile"]) {
                margin-left: 12px;
                margin-top: 2px;
                margin-bottom: 2px;
            }

            :host([data-mode="mobile"]) .ratings {
                gap: 10px;
            }

            :host([data-mode="mobile"]) .item {
                display: inline-flex;
                flex-direction: row;
                align-items: center;
                text-decoration: none;
                cursor: pointer;
                padding: 2px 4px;
                border-radius: 4px;
                gap: 4px;
                transition: background-color 0.15s ease;
            }

            :host([data-mode="mobile"]) .label {
                display: none;
            }

            :host([data-mode="mobile"]) .score-row {
                display: inline-flex;
                align-items: center;
                gap: 4px;
            }

            :host([data-mode="mobile"]) .icon-wrapper {
                width: 17px;
                height: 17px;
            }

            :host([data-mode="mobile"]) .score-val {
                font-size: 14px;
                font-weight: 600;
                color: #ffffff;
            }

            .item:hover {
                background-color: rgba(255, 255, 255, 0.15);
            }

            .icon-wrapper {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }

            .sub-val {
                font-size: 12px;
                color: rgba(255, 255, 255, 0.6);
            }

            .missing {
                color: rgba(255, 255, 255, 0.35);
                font-size: 13px;
            }
        `;

        const wrapper = document.createElement("div");
        wrapper.className = "ratings";

        const imdbId = getIMDbId();
        const title = getTitleName();

        for (const service of services) {
            const item = document.createElement("a");
            item.className = "item";
            item.dataset.service = service.id;
            item.target = "_blank";
            item.rel = "noopener noreferrer";

            item.href = getInitialHref(service, title, imdbId);

            const label = document.createElement("div");
            label.className = "label";
            label.textContent = service.name;

            const scoreRow = document.createElement("div");
            scoreRow.className = "score-row";

            const iconSpan = document.createElement("span");
            iconSpan.className = "icon-wrapper";
            iconSpan.innerHTML = service.icon;

            const valueSpan = document.createElement("span");
            valueSpan.className = "score-val";
            valueSpan.textContent = "-";

            scoreRow.append(iconSpan, valueSpan);
            item.append(label, scoreRow);
            wrapper.append(item);
        }

        shadow.append(style, wrapper);
        return { host, shadow };
    }
})();
