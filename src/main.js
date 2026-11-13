import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { dismissConsentDialog, extractFeedCards, extractPlaceDetails } from './extractors.js';

const LOCALE_MAP = {
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    it: 'it-IT',
    pt: 'pt-BR',
    ar: 'ar-SA',
    ja: 'ja-JP',
    ko: 'ko-KR',
    zh: 'zh-CN',
    nl: 'nl-NL',
    ru: 'ru-RU',
    tr: 'tr-TR',
    pl: 'pl-PL',
    sv: 'sv-SE',
    hi: 'hi-IN',
};

function normalizeLocale(lang) {
    if (!lang || typeof lang !== 'string') return 'en-US';
    const cleaned = lang.trim().replace('_', '-');
    const lower = cleaned.toLowerCase();
    if (LOCALE_MAP[lower]) return LOCALE_MAP[lower];
    if (/^[a-z]{2,3}-[A-Z]{2}$/i.test(cleaned)) {
        const [l, r] = cleaned.split('-');
        return `${l.toLowerCase()}-${r.toUpperCase()}`;
    }
    return 'en-US';
}

function parsePlaywrightProxy(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        const u = new URL(proxyUrl);
        const proxy = {
            server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
        };
        if (u.username) proxy.username = decodeURIComponent(u.username);
        if (u.password) proxy.password = decodeURIComponent(u.password);
        return proxy;
    } catch {
        return { server: proxyUrl };
    }
}

async function launchMapsSession(proxyUrl, rawLang, safeLocale) {
    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-webgl',
            '--disable-3d-apis',
            '--disable-accelerated-2d-canvas',
            '--disable-background-networking',
            '--disable-blink-features=AutomationControlled',
        ],
    };

    if (proxyUrl) {
        launchOptions.proxy = parsePlaywrightProxy(proxyUrl);
    }

    const browser = await chromium.launch(launchOptions);
    const baseContextOptions = {
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: {
            'Accept-Language': `${rawLang},${safeLocale},en;q=0.9`,
        },
    };

    let context = await browser.newContext({
        ...baseContextOptions,
        locale: safeLocale,
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let page;
    try {
        page = await context.newPage();
    } catch (localeErr) {
        if (localeErr.message && localeErr.message.includes('Invalid locale name')) {
            log.warning(`Browser rejected locale "${safeLocale}", recreating context with default locale...`);
            await context.close().catch(() => {});
            context = await browser.newContext(baseContextOptions);
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
            page = await context.newPage();
        } else {
            await browser.close().catch(() => {});
            throw localeErr;
        }
    }

    // Abort heavy assets (images, media, fonts, map tiles, WebGL data) to prevent Docker OOM crashes
    await page.route('**/*', (route) => {
        const req = route.request();
        const type = req.resourceType();
        const url = req.url();
        if (
            type === 'image' ||
            type === 'media' ||
            type === 'font' ||
            url.includes('/maps/vt?') ||
            url.includes('khms') ||
            url.includes('streetviewpixels') ||
            url.includes('googleusercontent.com') ||
            url.includes('ggpht.com')
        ) {
            return route.abort();
        }
        return route.continue();
    });

    return { browser, context, page };
}

function sanitizeRecord(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
        return value
            .map((item) => sanitizeRecord(item))
            .filter((item) => item !== null && item !== undefined);
    }
    if (typeof value === 'object' && !(value instanceof Date)) {
        const clean = {};
        for (const [k, v] of Object.entries(value)) {
            const next = sanitizeRecord(v);
            if (next !== null && next !== undefined) {
                clean[k] = next;
            }
        }
        return clean;
    }
    return value;
}

function isProxyTransportError(errOrStatus) {
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return errOrStatus === 597 || errOrStatus === 407 || /597|UPSTREAM407|407|Proxy responded with|tunneling socket|ECONNREFUSED/i.test(msg);
}

await Actor.init();

let hasFailed = false;

try {
    const input = (await Actor.getInput()) || {};
    const {
        searchStringsArray = ['cafes in London'],
        maxCrawledPlacesPerSearch = 40,
        language = 'en',
        includeOpeningHours = true,
        proxyConfiguration,
    } = input;

    let totalPlacesScraped = 0;
    let placesWithWebsite = 0;
    let placesWithPhone = 0;

    if (!Array.isArray(searchStringsArray) || searchStringsArray.length === 0) {
        log.warning('No search queries provided in searchStringsArray. Nothing to scrape.');
    } else {
        log.info(`Starting Google Maps Leads Scraper for ${searchStringsArray.length} queries (limit: ${maxCrawledPlacesPerSearch} places/query)`);

        let proxyConfig = null;
        if (proxyConfiguration) {
            try {
                proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
                if (proxyConfig) {
                    log.info('Configured Apify Proxy successfully');
                }
            } catch (proxyErr) {
                log.warning(`Apify Proxy initialization skipped (${proxyErr.message}); falling back to direct connection.`);
            }
        }

        const rawLang = (typeof language === 'string' && language.trim()) ? language.trim() : 'en';
        const safeLocale = normalizeLocale(rawLang);

        for (const query of searchStringsArray) {
            log.info(`Searching Google Maps for: "${query}"`);
            const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}/?hl=${encodeURIComponent(rawLang)}`;

            let session = null;
            let navigated = false;

            const attempts = proxyConfig ? ['proxy', 'proxy', 'direct'] : ['direct'];

            for (let i = 0; i < attempts.length; i++) {
                const mode = attempts[i];
                const attemptProxyUrl = mode === 'proxy' && proxyConfig ? await proxyConfig.newUrl() : undefined;

                if (session) {
                    await session.browser.close().catch(() => {});
                    session = null;
                }

                try {
                    session = await launchMapsSession(attemptProxyUrl, rawLang, safeLocale);
                    log.info(`Attempt ${i + 1}/${attempts.length} (${mode}): loading Google Maps...`);

                    const response = await session.page.goto(searchUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000,
                    });

                    const status = response ? response.status() : 'unknown';
                    const landedUrl = session.page.url();

                    if (status === 429 || landedUrl.includes('/sorry/')) {
                        log.warning(`Blocked by Google (status ${status}) on attempt ${i + 1}. Rotating...`);
                        continue;
                    }

                    log.info(`Loaded Maps page cleanly (HTTP ${status}) -> ${landedUrl}`);
                    navigated = true;
                    break;
                } catch (navErr) {
                    log.warning(`Navigation failed on attempt ${i + 1} (${mode}): ${navErr.message}`);
                    if (mode === 'proxy' && isProxyTransportError(navErr)) {
                        log.warning('Proxy transport error detected; disabling broken proxy for subsequent requests.');
                        proxyConfig = null;
                    }
                }
            }

            if (!navigated || !session) {
                log.error(`All navigation attempts failed for query "${query}".`);
                if (session) await session.browser.close().catch(() => {});
                continue;
            }

            const { page, browser } = session;

            try {
                // Handle Google cookie / consent dialog if present
                const dismissed = await dismissConsentDialog(page);
                if (dismissed) {
                    log.info('Dismissed Google consent dialog');
                    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
                }

                // Wait for either the results feed OR single-place heading
                await page.locator('div[role="feed"], h1.DUwDvf, h1.fontHeadlineLarge').first()
                    .waitFor({ state: 'visible', timeout: 15000 })
                    .catch(() => {});

                const currentUrl = page.url();
                const feedLocator = page.locator('div[role="feed"]').first();
                const feedExists = await feedLocator.isVisible().catch(() => false);

                // Case 1: Direct single-place page
                if (!feedExists) {
                    log.info(`Single place or direct entity match detected: ${currentUrl}`);
                    const details = await extractPlaceDetails(page, currentUrl, includeOpeningHours);
                    details.searchQuery = query;

                    if (details.title) {
                        await Actor.pushData(sanitizeRecord(details));
                        totalPlacesScraped++;
                        if (details.website) placesWithWebsite++;
                        if (details.phone) placesWithPhone++;
                        log.info(`[1/1] Extracted single place: "${details.title}" | Tel: ${details.phone || 'N/A'} | Web: ${details.website || 'N/A'}`);
                    } else {
                        log.warning(`No feed or place title found for query "${query}" (URL: ${currentUrl}).`);
                    }
                    continue;
                }

                log.info('Google Maps feed container detected. Extracting business cards...');

                // Case 2: Feed of multiple business listings
                const visitedUrls = new Set();
                let placesExtractedForQuery = 0;
                let scrollRetries = 0;
                let lastPanelTitle = '';

                while (placesExtractedForQuery < maxCrawledPlacesPerSearch && scrollRetries < 5) {
                    const cards = await extractFeedCards(page);
                    let newlyFound = 0;

                    for (const card of cards) {
                        if (placesExtractedForQuery >= maxCrawledPlacesPerSearch) break;
                        if (!card.url || visitedUrls.has(card.url)) continue;

                        visitedUrls.add(card.url);
                        newlyFound++;

                        let finalRecord = { ...card, searchQuery: query };

                        // Enrich card with full details (phone, website, full address, hours) via panel click
                        try {
                            const escapedHref = card.url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                            const linkLocator = page.locator(`div[role="feed"] a[href="${escapedHref}"]`).first();
                            const canClick = await linkLocator.isVisible().catch(() => false);

                            if (canClick) {
                                const prevHref = page.url();
                                await linkLocator.scrollIntoViewIfNeeded().catch(() => {});
                                await linkLocator.click({ force: true, timeout: 3000 }).catch(() => {});

                                // Wait until right-hand detail panel updates to this place
                                const updated = await page.waitForFunction(
                                    ({ prevTitle, oldHref }) => {
                                        const h1 = document.querySelector('h1.DUwDvf, h1.fontHeadlineLarge');
                                        const txt = h1 ? h1.textContent.trim() : '';
                                        return txt.length > 0 && txt.toLowerCase() !== 'results' && (txt !== prevTitle || window.location.href !== oldHref);
                                    },
                                    { prevTitle: lastPanelTitle, oldHref: prevHref },
                                    { timeout: 3000 }
                                ).then(() => true).catch(() => false);

                                if (updated) {
                                    const panelDetails = await extractPlaceDetails(page, card.url, includeOpeningHours);
                                    if (panelDetails.title) {
                                        lastPanelTitle = panelDetails.title;
                                        finalRecord = {
                                            ...finalRecord,
                                            title: panelDetails.title || finalRecord.title,
                                            category: panelDetails.category || finalRecord.category,
                                            address: panelDetails.address || finalRecord.address,
                                            phone: panelDetails.phone || finalRecord.phone,
                                            website: panelDetails.website || finalRecord.website,
                                            totalScore: panelDetails.totalScore ?? finalRecord.totalScore,
                                            reviewsCount: panelDetails.reviewsCount || finalRecord.reviewsCount,
                                            openStatus: panelDetails.openStatus || finalRecord.openStatus,
                                            openingHours: panelDetails.openingHours || finalRecord.openingHours,
                                            latitude: panelDetails.latitude ?? finalRecord.latitude,
                                            longitude: panelDetails.longitude ?? finalRecord.longitude,
                                        };
                                    }
                                }
                            }
                        } catch (detailErr) {
                            log.debug(`Detail click skipped for "${card.title}", using card summary: ${detailErr.message}`);
                        }

                        if (finalRecord.title) {
                            await Actor.pushData(sanitizeRecord(finalRecord));
                            placesExtractedForQuery++;
                            totalPlacesScraped++;
                            if (finalRecord.website) placesWithWebsite++;
                            if (finalRecord.phone) placesWithPhone++;

                            log.info(`[${placesExtractedForQuery}/${maxCrawledPlacesPerSearch}] Extracted: "${finalRecord.title}" | Tel: ${finalRecord.phone || 'N/A'} | Web: ${finalRecord.website || 'N/A'}`);
                        }
                    }

                    if (placesExtractedForQuery < maxCrawledPlacesPerSearch) {
                        const scrollSuccess = await feedLocator.evaluate((el) => {
                            const prevScroll = el.scrollTop;
                            el.scrollBy(0, 1200);
                            return el.scrollTop > prevScroll;
                        }).catch(() => false);

                        await page.waitForTimeout(1500);

                        const endBanner = page.locator('text="You\'ve reached the end of the list"').first();
                        const isEnd = await endBanner.isVisible().catch(() => false);

                        if (isEnd || (!scrollSuccess && newlyFound === 0)) {
                            scrollRetries++;
                            log.debug(`Scroll stalled or reached end of list (${scrollRetries}/5)`);
                        } else {
                            scrollRetries = 0;
                        }
                    }
                }

                log.info(`Completed query "${query}": ${placesExtractedForQuery} places extracted.`);
            } catch (queryErr) {
                log.error(`Error processing query "${query}": ${queryErr.message}`);
            } finally {
                await browser.close().catch(() => {});
            }
        }
    }

    const summary = {
        totalQueries: Array.isArray(searchStringsArray) ? searchStringsArray.length : 0,
        totalPlacesScraped,
        placesWithWebsite,
        placesWithPhone,
        status: totalPlacesScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    if (totalPlacesScraped === 0) {
        hasFailed = true;
        await Actor.fail('Extracted 0 Google Maps places.');
    }
    log.info(`Scraping finished successfully! Total places scraped: ${totalPlacesScraped}`);

} catch (err) {
    hasFailed = true;
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message }).catch(() => {});
    await Actor.fail(err.message);
} finally {
    if (!hasFailed) {
        await Actor.exit();
    }
}
