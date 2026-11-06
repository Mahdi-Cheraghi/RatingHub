# RatingHub

Userscript that adds Rotten Tomatoes (critic + audience), Metacritic and
Letterboxd ratings next to IMDb's own rating on `imdb.com/title/*` pages.
Scores come from [MDBList](https://mdblist.com), so an API key is needed.

Files:

- `ratingHub.user.js` — the maintained userscript.
- `imdb-inline-ratings.user.js` — the original reference implementation,
  kept untouched for comparison.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new userscript and paste the contents of `ratingHub.user.js`,
   or install the file directly if your setup supports it.
3. Open any IMDb title page (e.g. `https://www.imdb.com/title/tt0111161/`).

## Setup

- Tampermonkey menu → **Set MDBList API Key** and paste your key
  (free at mdblist.com — API key section of the account settings).
- **Refresh Ratings** rebuilds the badges for the current title.

## How it behaves

- Badge links go to the matching RT / Metacritic / Letterboxd page. If the
  direct page can't be confirmed, the badge links to the site's search
  instead and the lookup is retried later.
- Ratings are cached for 6 hours, resolved direct links for 24 (failed
  lookups for 1), so pages don't refetch everything on every visit.
- Works in the mobile layout too; the badges follow the responsive layout
  IMDb serves.
