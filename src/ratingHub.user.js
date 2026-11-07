// ==UserScript==
// @name          RatingHub
// @namespace     https://github.com/Mahdi-Cheraghi/RatingHub
// @version       1.0.4
// @description   Display Rotten Tomatoes, Metacritic, and Letterboxd ratings alongside IMDb ratings.
// @author        Mahdi Cheraghi
// @license       MIT
// @homepageURL   https://github.com/Mahdi-Cheraghi/RatingHub
// @supportURL    https://github.com/Mahdi-Cheraghi/RatingHub/issues
// @icon          https://raw.githubusercontent.com/Mahdi-Cheraghi/RatingHub/main/assets/logo/128x128/logo.png
//
// @match         https://www.imdb.com/title/*
// @run-at        document-idle
//
// @grant         GM_getValue
// @grant         GM_setValue
// @grant         GM_registerMenuCommand
// @grant         GM_xmlhttpRequest
//
// @connect       api.mdblist.com
// @connect       www.rottentomatoes.com
// @connect       www.metacritic.com
// @connect       www.letterboxd.com
// ==/UserScript==

/**
 * RatingHub
 *
 * Displays external movie and TV ratings alongside IMDb's native rating,
 * including Rotten Tomatoes (Tomatometer and Audience Score),
 * Metacritic, and Letterboxd.
 *
 * All rating data is retrieved through the MDBList API.
 * An MDBList API key is required and can be configured through
 * the Tampermonkey menu.
 *
 * External rating links are resolved and validated against the
 * corresponding page metadata before being displayed.
 *
 * Verified links are cached for 24 hours, while search fallback
 * results are cached for 1 hour to allow unsuccessful lookups
 * to be retried.
 */

(() => {
    "use strict";

    const API_BASE = "https://api.mdblist.com";
    const API_KEY_STORAGE = "mdblist_api_key";

    const RATING_CACHE_PREFIX = "mdblist_rating_";
    const RATING_CACHE_TTL = 6 * 60 * 60 * 1000;

    const LINK_CACHE_PREFIX = "mdblist_link_";
    const LINK_TTL_OK = 24 * 60 * 60 * 1000;
    const LINK_TTL_FAIL = 1 * 60 * 60 * 1000;

    const DEBUG = true;
    let activeId = "";
    let activeMountType = "";
    let observer = null;
    let resizeTimer = 0;
    let requestToken = 0;
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

    // --- API key ---

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

    // --- Page info ---

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
                // bad or partial JSON block, just keep scanning
            }
        }
        return "movie";
    }

    // --- Text helpers ---

    const norm = (s) =>
        String(s || "")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");

    // pages add junk to titles (years, networks) — that shouldn't break the match.
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

    // --- Networking ---

    // fetch a cross-origin page via the userscript sandbox — used to verify
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

    // --- Link resolution ---

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

    // guess direct RT/Metacritic page → verify og:title. on failure, search
    // URL instead (`ok` tells which). failed guesses cached with short TTL.
    async function resolveDirectLink(service, title, imdbId, type) {
        if (service.id === "letterboxd") {
            return { url: `https://letterboxd.com/imdb/${imdbId}/`, ok: true };
        }

        try {
            if (service.direct === "rt") {
                const part = type === "show" ? "tv" : "m";
                const page = `https://www.rottentomatoes.com/${part}/${slugify(title, "_")}`;
                const html = await fetchPage(page);
                const og = extractOgTitle(html).replace(
                    /\s*-\s*Season.*$/i,
                    "",
                );
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
            // whatever went wrong, fall back to search
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

    // --- Mount points ---

    function isVisible(el) {
        try {
            return !!el && el.getClientRects().length > 0;
        } catch {
            return false;
        }
    }

    const DESKTOP_SELECTORS = [
        '[data-testid="hero-rating-bar__aggregate-rating"]',
    ];

    // mobile has no rating bar, so use the popularity rows (or the title as a last resort) as the anchor.
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

    // --- UI ---

    // closed shadow root isolates badges from IMDb CSS.
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

    // pre-ratings href: fresh cached link, else the site's search page.
    function getInitialHref(service, title, imdbId) {
        if (service.id === "letterboxd") {
            return imdbId
                ? `https://letterboxd.com/imdb/${imdbId}/`
                : `https://letterboxd.com/search/${encodeURIComponent(title)}/`;
        }

        const cached = imdbId ? getCachedLink(service, imdbId) : null;
        if (cached) {
            log(
                "INIT cached link",
                service.id,
                cached.url,
                cached.ok ? "ok" : "search",
            );
            return cached.url;
        }

        const searchUrl =
            service.direct === "rt"
                ? `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`
                : `https://www.metacritic.com/search/${encodeURIComponent(title)}/?category=13`;
        log("INIT initial link", service.id, searchUrl);
        return searchUrl;
    }

    // search link, not a real page.
    function isSearchPlaceholder(serviceId, href) {
        if (!href) return true;
        if (serviceId === "tomatoes" || serviceId === "popcorn") {
            return href.startsWith("https://www.rottentomatoes.com/search");
        }
        if (serviceId === "metacritic") {
            return href.startsWith("https://www.metacritic.com/search");
        }
        return false;
    }

    function serviceFallback(service, title, imdbId, type) {
        if (service.id === "letterboxd") {
            return imdbId
                ? `https://letterboxd.com/imdb/${imdbId}/`
                : `https://letterboxd.com/search/${encodeURIComponent(title)}/`;
        }
        if (service.direct === "rt") {
            return `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`;
        }
        return `https://www.metacritic.com/search/${encodeURIComponent(title)}/?category=${type === "show" ? "2" : "13"}`;
    }

    // apply ratings once they arrive.
    function updateUI(shadow, ratings, title, imdbId, type) {
        for (const service of services) {
            const item = shadow.querySelector(`[data-service="${service.id}"]`);
            if (!item) continue;

            const score = item.querySelector(".score-val");

            const rating = ratings.find((entry) => {
                const source = String(entry.source || "")
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, "");
                return service.aliases.some(
                    (alias) => source === alias.replace(/[^a-z0-9]/g, ""),
                );
            });

            const value = rating?.value ?? rating?.score;

            if (
                value === null ||
                value === undefined ||
                value === "" ||
                !Number.isFinite(Number(value))
            ) {
                score.textContent = "—";
                score.className = "score-val missing";
                continue;
            }

            const cached = getCachedLink(service, imdbId);
            let linkUrl =
                rating?.url ||
                (cached?.ok ? cached.url : null) ||
                item.getAttribute("href") ||
                serviceFallback(service, title, imdbId, type);

            if (linkUrl && linkUrl.startsWith("/")) {
                let origin;
                if (service.id === "letterboxd") {
                    origin = "https://letterboxd.com";
                } else if (service.direct === "rt") {
                    origin = "https://www.rottentomatoes.com";
                } else {
                    origin = `https://www.metacritic.com/${type === "show" ? "tv" : "movie"}`;
                }
                linkUrl = origin + linkUrl;
            }

            const isDirect =
                Boolean(rating?.url) ||
                !isSearchPlaceholder(service.id, linkUrl);

            item.href = linkUrl;
            item.classList.remove("disabled");
            item.dataset.link = isDirect ? "direct" : "search";
            log(
                "UPDATE link",
                service.id,
                linkUrl,
                item.dataset.link,
                "val=",
                value,
            );

            score.className = "score-val";
            const num = Number(value);
            const formatted = Number.isInteger(num) ? num : num.toFixed(1);

            if (service.suffix.startsWith("/")) {
                score.innerHTML = `${formatted}<span class="sub-val">${service.suffix}</span>`;
            } else {
                score.textContent = `${formatted}${service.suffix}`;
            }

            // search link with no verified direct page yet — resolve in background.
            const needsResolve =
                !rating?.url &&
                (!cached || !cached.ok) &&
                isSearchPlaceholder(service.id, linkUrl) &&
                service.direct;

            if (needsResolve && imdbId) {
                queueLinkResolution(service, title, imdbId, type);
            }
        }
    }

    // resolve placeholder links separately. one lookup per service/title,
    // result cached either way (page or search fallback).
    const pendingLinks = new Set();

    async function queueLinkResolution(service, title, imdbId, type) {
        const pendingKey = `${service.id}:${imdbId}`;
        if (pendingLinks.has(pendingKey)) return;
        pendingLinks.add(pendingKey);

        try {
            const cached = getCachedLink(service, imdbId);
            const result =
                cached ||
                (await resolveDirectLink(service, title, imdbId, type));

            if (!cached) {
                GM_setValue(LINK_CACHE_PREFIX + service.id + imdbId, {
                    time: Date.now(),
                    url: result.url,
                    ok: result.ok,
                });
                log(
                    "RESOLVE cached",
                    service.id,
                    result.url,
                    result.ok ? "ok" : "search",
                );
            }

            // stale request after navigation, skip
            if (getIMDbId() !== imdbId) return;

            const item = activeUI?.shadow?.querySelector(
                `[data-service="${service.id}"]`,
            );
            if (!item) return;

            if (
                result.ok &&
                isSearchPlaceholder(service.id, item.getAttribute("href"))
            ) {
                item.href = result.url;
                item.dataset.link = "direct";
                log("RESOLVE applied", service.id, result.url);
            }
        } finally {
            pendingLinks.delete(pendingKey);
        }
    }

    // get ratings for a single title from MDBList.
    function requestRatings(id, type, apiKey) {
        const url = new URL(`${API_BASE}/imdb/${type}/${id}/`);
        url.searchParams.set("apikey", apiKey);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url.href,
                timeout: 15000,
                headers: { Accept: "application/json" },
                onload(response) {
                    if (response.status !== 200) {
                        reject(new Error(`MDBList HTTP ${response.status}`));
                        return;
                    }
                    try {
                        const data = JSON.parse(response.responseText);
                        if (!Array.isArray(data.ratings)) {
                            reject(
                                new Error("Unexpected API response structure."),
                            );
                            return;
                        }
                        resolve(data.ratings);
                    } catch {
                        reject(new Error("Invalid JSON response."));
                    }
                },
                onerror: () => reject(new Error("Network error.")),
                ontimeout: () => reject(new Error("Request timeout.")),
            });
        });
    }

    // cache-first. falls back to empty ratings on miss/no-key/error.
    async function loadRatings(id, type, ui, token) {
        const apiKey = getApiKey();
        const title = getTitleName();

        if (!apiKey) {
            updateUI(ui.shadow, [], title, id, type);
            return;
        }

        try {
            const cached = GM_getValue(RATING_CACHE_PREFIX + id, null);
            if (
                cached &&
                Date.now() - cached.time < RATING_CACHE_TTL &&
                Array.isArray(cached.ratings)
            ) {
                updateUI(ui.shadow, cached.ratings, title, id, type);
                return;
            }

            const ratings = await requestRatings(id, type, apiKey);
            if (token !== requestToken || getIMDbId() !== id) return;

            GM_setValue(RATING_CACHE_PREFIX + id, {
                time: Date.now(),
                ratings,
            });
            updateUI(ui.shadow, ratings, title, id, type);
            return;
        } catch (error) {
            if (token !== requestToken) return;
            console.error("[MDBList]", error);
        }

        updateUI(ui.shadow, [], title, id, type);
    }

    function initialize(force = false) {
        const id = getIMDbId();
        if (!id) return;

        const mount = getMountPoint();
        if (!mount) return;

        const existing = document.getElementById("mdblist-inline-ratings");

        if (
            !force &&
            activeId === id &&
            existing &&
            activeMountType === mount.type
        ) {
            if (isVisible(existing) || !isVisible(mount.anchor)) {
                return;
            }
        }

        activeMountType = mount.type;
        const type = getMediaType();
        activeId = id;
        requestToken++;
        const token = requestToken;

        existing?.remove();

        const ui = createUI(mount.type === "mobile");
        activeUI = ui;
        mount.insertMethod(mount.parent, ui.host, mount.anchor);

        loadRatings(id, type, ui, token);
    }

    function startObserver() {
        observer?.disconnect();
        observer = new MutationObserver(() => {
            const id = getIMDbId();
            if (!id) return;

            const existing = document.getElementById("mdblist-inline-ratings");
            const mount = getMountPoint();

            if (
                id !== activeId ||
                !existing ||
                (mount && activeMountType !== mount.type)
            ) {
                initialize();
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        // Debounced resize: IMDb switches layouts at ~1024px
        window.addEventListener("resize", () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => initialize(), 250);
        });
    }

    initialize();
    startObserver();
})();
