// ==UserScript==
// @name         Torn City & Foreign Stock Watch (fork Workaround)
// @namespace    workaround.stock-watch-fork
// @version      0.2.1-fork
// @downloadURL  https://raw.githubusercontent.com/LittleBigDev/torn-stock-watch-fork/main/torn-stock-watch-fork.user.js
// @updateURL    https://raw.githubusercontent.com/LittleBigDev/torn-stock-watch-fork/main/torn-stock-watch-fork.user.js
// @description  Fork de Torn City & Foreign Stock Watch 0.2.1 : heures en heure locale.
// @license      MIT
// @match        https://www.torn.com/*
// @connect      api.torn.com
// @connect      api.prombot.co.uk
// @connect      yata.yt
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_NAME = 'Torn City & Foreign Stock Watch';
  const API_URL = 'https://api.torn.com/v2/torn/cityshops?comment=CityStockWatch';
  const KEY_INFO_URL = 'https://api.torn.com/v2/key/info?comment=CityStockWatch';
  const FOREIGN_FEEDS = Object.freeze([
    { name: 'Prometheus Bot', url: 'https://api.prombot.co.uk/api/travel' },
    { name: 'YATA', url: 'https://yata.yt/api/v1/travel/export/' },
  ]);
  const FOREIGN_COUNTRIES = Object.freeze({
    mex: { name: 'Mexico', flag: '🇲🇽' },
    cay: { name: 'Cayman Islands', flag: '🇰🇾' },
    can: { name: 'Canada', flag: '🇨🇦' },
    haw: { name: 'Hawaii', flag: '🌺' },
    uni: { name: 'United Kingdom', flag: '🇬🇧' },
    arg: { name: 'Argentina', flag: '🇦🇷' },
    swi: { name: 'Switzerland', flag: '🇨🇭' },
    jap: { name: 'Japan', flag: '🇯🇵' },
    chi: { name: 'China', flag: '🇨🇳' },
    uae: { name: 'UAE', flag: '🇦🇪' },
    sou: { name: 'South Africa', flag: '🇿🇦' },
  });
  const LEGACY_STORAGE_KEY = 'tcsw_state_v1';
  const DATA_STORAGE_KEY = 'tcsw_data_v1';
  const PREFERENCES_STORAGE_KEY = 'tcsw_preferences_v1';
  const LEGACY_API_KEY_STORAGE = 'tcsw_public_api_key';
  const API_KEY_STORAGE = 'tcsw_verified_public_only_api_key_v2';
  const TAB_LOCK_KEY = 'tcsw_poll_lock_v1';
  const TAB_LAST_POLL_KEY = 'tcsw_last_successful_poll_v1';
  const HEADER_LAUNCHER_ID = 'tcsw-status-launcher';
  const HEADER_STYLE_ID = 'tcsw-status-launcher-style';
  const QUARTER_HOUR_MS = 15 * 60 * 1000;
  const MAX_MODEL_SAMPLE_GAP_MS = 150 * 1000;
  const MAX_CYCLES = 12;
  const MAX_EVENTS = 24;
  const FOREIGN_POLL_MS = 60 * 1000;
  const FOREIGN_STALE_MS = 30 * 60 * 1000;
  const MAX_FOREIGN_CLOCK_SKEW_MS = 5 * 60 * 1000;
  const MAX_FOREIGN_RESPONSE_CHARS = 2 * 1024 * 1024;
  const FOREIGN_REQUEST_TIMEOUT_MS = 12 * 1000;
  const MAX_FOREIGN_ITEMS = 1000;
  const MAX_FOREIGN_ITEMS_PER_COUNTRY = 250;
  const MAX_FOREIGN_NAME_LENGTH = 160;
  const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;
  const PERMANENT_KEY_ERROR_CODES = new Set([1, 2, 10, 13, 16, 18]);
  const SHOP_PATHS = Object.freeze({
    bigalsgunshop: '/bigalgunshop.php',
    bigals: '/bigalgunshop.php',
    bitsnbobs: '/shops.php?step=bitsnbobs',
    cyberforce: '/shops.php?step=cyberforce',
    docks: '/shops.php?step=docks',
    thedocks: '/shops.php?step=docks',
    jewelry: '/shops.php?step=jewelry',
    jewelrystore: '/shops.php?step=jewelry',
    nikeh: '/shops.php?step=nikeh',
    nikehsports: '/shops.php?step=nikeh',
    pawnshop: '/shops.php?step=pawnshop',
    pharmacy: '/shops.php?step=pharmacy',
    postoffice: '/shops.php?step=postoffice',
    printstore: '/shops.php?step=printstore',
    printshop: '/shops.php?step=printstore',
    recyclingcenter: '/shops.php?step=recyclingcenter',
    superstore: '/shops.php?step=super',
    supermarket: '/shops.php?step=super',
    sallyssweetshop: '/shops.php?step=candy',
    sweetshop: '/shops.php?step=candy',
    candyshop: '/shops.php?step=candy',
    tcclothing: '/shops.php?step=clothes',
    clothingstore: '/shops.php?step=clothes',
    clothesshop: '/shops.php?step=clothes',
  });
  const TAB_ID =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const DEFAULT_STATE = Object.freeze({
    version: 2,
    settings: {
      pollSeconds: 30,
      notifications: true,
    },
    watched: [],
    items: {},
    notified: {},
    lastFetchAt: null,
    lastSnapshotKeys: [],
    lastForeignAttemptAt: null,
    lastForeignFetchAt: null,
    lastForeignError: null,
    foreignProvider: null,
    foreignCountryUpdates: {},
  });

  let state = clone(DEFAULT_STATE);
  let apiKey = '';
  let host = null;
  let shadow = null;
  let nativeLauncher = null;
  let headerObserver = null;
  let headerRefreshTimer = null;
  let pollTimer = null;
  let pollInFlight = false;
  let retryAfter = 0;
  let status = { kind: 'idle', text: 'Waiting for setup' };
  const ui = { open: false, view: 'watched', query: '', source: 'all', shop: 'all' };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isValidPreferencesPayload(value) {
    return isRecord(value) && isRecord(value.settings) && Array.isArray(value.watched);
  }

  function isValidDataPayload(value) {
    return isRecord(value) && isRecord(value.items) && isRecord(value.notified);
  }

  function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function ceilToQuarterHour(timestamp) {
    return Math.ceil(timestamp / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  }

  function floorToQuarterHour(timestamp) {
    return Math.floor(timestamp / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  }

  function normalizeState(raw) {
    const next = clone(DEFAULT_STATE);
    if (!isRecord(raw)) return next;

    next.settings.pollSeconds = [30, 60, 120, 300].includes(
      Number(raw.settings?.pollSeconds),
    )
      ? Number(raw.settings.pollSeconds)
      : DEFAULT_STATE.settings.pollSeconds;
    next.settings.notifications = raw.settings?.notifications !== false;
    next.watched = Array.isArray(raw.watched)
      ? [...new Set(raw.watched.filter((key) => typeof key === 'string'))]
      : [];
    next.items = isRecord(raw.items) ? raw.items : {};
    for (const [key, item] of Object.entries(next.items)) {
      if (!item || typeof item !== 'object') continue;
      if (item.source !== 'city' && item.source !== 'foreign') {
        item.source = key.startsWith('foreign:') ? 'foreign' : 'city';
      }
    }
    next.notified = isRecord(raw.notified) ? raw.notified : {};
    next.lastFetchAt = Number.isFinite(raw.lastFetchAt) ? raw.lastFetchAt : null;
    next.lastSnapshotKeys = Array.isArray(raw.lastSnapshotKeys)
      ? [...new Set(raw.lastSnapshotKeys.filter((key) => typeof key === 'string'))]
      : [];
    next.lastForeignAttemptAt = Number.isFinite(raw.lastForeignAttemptAt)
      ? raw.lastForeignAttemptAt
      : null;
    next.lastForeignFetchAt = Number.isFinite(raw.lastForeignFetchAt)
      ? raw.lastForeignFetchAt
      : null;
    next.lastForeignError = typeof raw.lastForeignError === 'string'
      ? raw.lastForeignError.slice(0, 240)
      : null;
    next.foreignProvider = typeof raw.foreignProvider === 'string'
      ? raw.foreignProvider
      : null;
    next.foreignCountryUpdates =
      isRecord(raw.foreignCountryUpdates)
        ? Object.fromEntries(
            Object.entries(raw.foreignCountryUpdates).filter(
              ([code, updatedAt]) =>
                Object.prototype.hasOwnProperty.call(FOREIGN_COUNTRIES, code) &&
                Number.isFinite(updatedAt),
            ),
          )
        : {};
    return next;
  }

  async function gmGet(key, fallback) {
    try {
      return await Promise.resolve(GM_getValue(key, fallback));
    } catch (_error) {
      return fallback;
    }
  }

  async function gmSet(key, value) {
    await Promise.resolve(GM_setValue(key, value));
  }

  async function gmDelete(key) {
    if (typeof GM_deleteValue === 'function') {
      await Promise.resolve(GM_deleteValue(key));
    } else {
      await gmSet(key, '');
    }
  }

  function preferencePayload(source = state) {
    return {
      version: source.version,
      settings: source.settings,
      watched: source.watched,
    };
  }

  function dataPayload(source = state) {
    return {
      version: source.version,
      items: source.items,
      notified: source.notified,
      lastFetchAt: source.lastFetchAt,
      lastSnapshotKeys: source.lastSnapshotKeys,
      lastForeignAttemptAt: source.lastForeignAttemptAt,
      lastForeignFetchAt: source.lastForeignFetchAt,
      lastForeignError: source.lastForeignError,
      foreignProvider: source.foreignProvider,
      foreignCountryUpdates: source.foreignCountryUpdates,
    };
  }

  async function savePreferences() {
    await gmSet(PREFERENCES_STORAGE_KEY, preferencePayload());
  }

  async function saveData() {
    await gmSet(DATA_STORAGE_KEY, dataPayload());
  }

  async function mergeLatestPreferences() {
    const raw = await gmGet(PREFERENCES_STORAGE_KEY, null);
    if (!raw || typeof raw !== 'object') return;
    const latest = normalizeState(raw);
    state.watched = latest.watched;
    state.settings = latest.settings;
  }

  async function mergeLatestData() {
    const raw = await gmGet(DATA_STORAGE_KEY, null);
    if (!raw || typeof raw !== 'object') return;
    const latest = normalizeState(raw);
    state.items = latest.items;
    state.notified = latest.notified;
    state.lastFetchAt = latest.lastFetchAt;
    state.lastSnapshotKeys = latest.lastSnapshotKeys;
    state.lastForeignAttemptAt = latest.lastForeignAttemptAt;
    state.lastForeignFetchAt = latest.lastForeignFetchAt;
    state.lastForeignError = latest.lastForeignError;
    state.foreignProvider = latest.foreignProvider;
    state.foreignCountryUpdates = latest.foreignCountryUpdates;
  }

  function registerStorageSync() {
    if (typeof GM_addValueChangeListener !== 'function') return;

    GM_addValueChangeListener(PREFERENCES_STORAGE_KEY, (_name, _oldValue, newValue, remote) => {
      if (!remote) return;
      const latest = normalizeState(newValue);
      state.settings = latest.settings;
      state.watched = latest.watched;
      render();
    });

    GM_addValueChangeListener(DATA_STORAGE_KEY, (_name, _oldValue, newValue, remote) => {
      if (!remote) return;
      const latest = normalizeState(newValue);
      state.items = latest.items;
      state.notified = latest.notified;
      state.lastFetchAt = latest.lastFetchAt;
      state.lastSnapshotKeys = latest.lastSnapshotKeys;
      state.lastForeignAttemptAt = latest.lastForeignAttemptAt;
      state.lastForeignFetchAt = latest.lastForeignFetchAt;
      state.lastForeignError = latest.lastForeignError;
      state.foreignProvider = latest.foreignProvider;
      state.foreignCountryUpdates = latest.foreignCountryUpdates;
      render();
    });

    GM_addValueChangeListener(API_KEY_STORAGE, (_name, _oldValue, newValue, remote) => {
      if (!remote) return;
      apiKey = String(newValue || '').trim();
      status = apiKey
        ? { kind: 'idle', text: 'API key updated in another tab' }
        : { kind: 'idle', text: 'Waiting for setup' };
      render();
      if (apiKey) schedulePoll();
      else clearTimeout(pollTimer);
    });
  }

  function itemKey(shopId, itemId) {
    return `${shopId}:${itemId}`;
  }

  function foreignItemKey(countryCode, itemId) {
    return `foreign:${countryCode}:${itemId}`;
  }

  function isForeignItem(item) {
    return item?.source === 'foreign' || String(item?.key || '').startsWith('foreign:');
  }

  function foreignItemCount() {
    return Object.values(state.items || {}).filter(isForeignItem).length;
  }

  function safeErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');
    return message.replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  function shopUrl(item) {
    if (isForeignItem(item)) return 'https://www.torn.com/page.php?sid=travel';
    const normalized = String(item?.shopName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    return `https://www.torn.com${SHOP_PATHS[normalized] || '/city.php'}`;
  }

  function isWatched(key) {
    return state.watched.includes(key);
  }

  function completedCycles(item) {
    return (item.cycles || []).filter(
      (cycle) =>
        !cycle.uncertain &&
        Number.isFinite(cycle.restockedAt) &&
        Number.isFinite(cycle.soldOutAt) &&
        Number.isFinite(cycle.nextRestockedAt) &&
        cycle.soldOutAt > cycle.restockedAt &&
        cycle.nextRestockedAt > cycle.soldOutAt,
    );
  }

  function modelCycles(item) {
    return completedCycles(item).filter(
      (cycle) =>
        asNumber(cycle.maxSampleGap, Number.POSITIVE_INFINITY) <= MAX_MODEL_SAMPLE_GAP_MS,
    );
  }

  function predictedTickForRatio(cycle, ratio) {
    const selloutDuration = cycle.soldOutAt - cycle.restockedAt;
    return ceilToQuarterHour(cycle.soldOutAt + selloutDuration * ratio);
  }

  function fitTickAwareRatio(cycles) {
    if (cycles.length < 2) return 0.5;
    const minimumRatio = 0.01;
    const maximumRatio = Math.min(
      10000,
      Math.max(
        0.5,
        ...cycles.map((cycle) => {
          const duration = cycle.soldOutAt - cycle.restockedAt;
          const observedTick = floorToQuarterHour(cycle.nextRestockedAt);
          return duration > 0 ? (observedTick - cycle.soldOutAt) / duration : 0.5;
        }),
      ),
    );
    const candidates = new Set([minimumRatio, Math.min(0.5, maximumRatio), maximumRatio]);
    const addCandidate = (ratio) => {
      if (Number.isFinite(ratio) && ratio >= minimumRatio && ratio <= maximumRatio) {
        candidates.add(ratio);
      }
    };

    for (const cycle of cycles) {
      const duration = cycle.soldOutAt - cycle.restockedAt;
      if (duration <= 0) continue;

      const firstTick = Math.floor(
        (cycle.soldOutAt + duration * minimumRatio) / QUARTER_HOUR_MS,
      );
      const lastTick = Math.ceil(
        (cycle.soldOutAt + duration * maximumRatio) / QUARTER_HOUR_MS,
      );
      const tickCount = Math.max(1, lastTick - firstTick + 1);
      const stride = Math.max(1, Math.ceil(tickCount / 500));
      const addTickBoundary = (tick) => {
        const boundary = (tick * QUARTER_HOUR_MS - cycle.soldOutAt) / duration;
        const epsilon = Math.max(1e-9, Math.abs(boundary) * 1e-10);
        addCandidate(boundary - epsilon);
        addCandidate(boundary);
        addCandidate(boundary + epsilon);
      };
      for (let tick = firstTick; tick <= lastTick; tick += stride) {
        addTickBoundary(tick);
      }
      addTickBoundary(lastTick);
    }

    let bestRatio = 0.5;
    let bestLoss = Number.POSITIVE_INFINITY;
    for (const ratio of candidates) {
      const loss = predictionTickLoss(cycles, ratio);
      const tied = Math.abs(loss - bestLoss) < 1e-9;
      if (loss < bestLoss || (tied && Math.abs(ratio - 0.5) < Math.abs(bestRatio - 0.5))) {
        bestLoss = loss;
        bestRatio = ratio;
      }
    }
    return bestRatio;
  }

  function predictionTickLoss(cycles, ratio) {
    return cycles.reduce((total, cycle) => {
      const observedTick = floorToQuarterHour(cycle.nextRestockedAt);
      const predictedTick = predictedTickForRatio(cycle, ratio);
      return total + Math.abs(predictedTick - observedTick) / QUARTER_HOUR_MS;
    }, 0);
  }

  function learnedRatio(item) {
    return fitTickAwareRatio(modelCycles(item));
  }

  function predictionConfidence(item) {
    const cycles = modelCycles(item);
    if (cycles.length < 2) return { label: 'low', samples: cycles.length };

    const tickErrors = cycles.map((cycle, index) => {
      const training = cycles.filter((_entry, trainingIndex) => trainingIndex !== index);
      const ratio = fitTickAwareRatio(training);
      return (
        Math.abs(
          predictedTickForRatio(cycle, ratio) - floorToQuarterHour(cycle.nextRestockedAt),
        ) / QUARTER_HOUR_MS
      );
    });
    const typicalError = median(tickErrors);
    const worstError = Math.max(...tickErrors);
    const worstSampleGap = Math.max(
      ...cycles.map((cycle) => asNumber(cycle.maxSampleGap, Number.POSITIVE_INFINITY)),
    );
    if (
      cycles.length >= 8 &&
      worstSampleGap <= 90000 &&
      typicalError !== null &&
      typicalError <= 0.5 &&
      worstError <= 1
    ) {
      return { label: 'high', samples: cycles.length };
    }
    const medium =
      cycles.length >= 3 &&
      worstSampleGap <= MAX_MODEL_SAMPLE_GAP_MS &&
      typicalError !== null &&
      typicalError <= 1 &&
      worstError <= 2;
    return { label: medium ? 'medium' : 'low', samples: cycles.length };
  }

  function predictCycle(item, cycle) {
    if (!cycle?.restockedAt || !cycle?.soldOutAt || cycle.uncertain) return null;
    const selloutDuration = cycle.soldOutAt - cycle.restockedAt;
    if (selloutDuration <= 0) return null;
    const estimated = cycle.soldOutAt + selloutDuration * learnedRatio(item);
    return ceilToQuarterHour(estimated);
  }

  function looksLikeRestock(previous, current, defaultStock) {
    if (!(current > previous)) return false;
    if (previous === 0) return true;
    if (defaultStock <= 0) return false;
    return current >= defaultStock * 0.85 || current - previous >= defaultStock * 0.25;
  }

  function addEvent(item, event) {
    item.events = [...(item.events || []), event].slice(-MAX_EVENTS);
  }

  function closePreviousCycle(item, observedAt) {
    const cycle = [...(item.cycles || [])]
      .reverse()
      .find((entry) => entry.soldOutAt && !entry.nextRestockedAt && !entry.uncertain);
    if (!cycle) return;

    cycle.nextRestockedAt = observedAt;
    cycle.observedTick = floorToQuarterHour(observedAt);
  }

  function recordCycleSampleGap(item, sampleGap) {
    for (const cycle of item.cycles || []) {
      if (!cycle.nextRestockedAt && !cycle.uncertain) {
        cycle.maxSampleGap = Math.max(asNumber(cycle.maxSampleGap), sampleGap);
      }
    }
  }

  function invalidateOpenCycles(item) {
    for (const cycle of item.cycles || []) {
      if (!cycle.nextRestockedAt) cycle.uncertain = true;
    }
  }

  function reliableSampleGapMs() {
    return (state.settings.pollSeconds * 2 + 35) * 1000;
  }

  function processStockResponse(payload, observedAt = Date.now()) {
    if (!payload || !Array.isArray(payload.cityshops)) {
      throw new Error('The API returned an unexpected cityshops response.');
    }

    const snapshotByKey = new Map();
    for (const shop of payload.cityshops) {
      if (!shop || !Array.isArray(shop.items)) continue;
      if (!Number.isSafeInteger(shop.id) || shop.id <= 0) continue;
      const shopId = shop.id;

      for (const apiItem of shop.items) {
        const id = apiItem?.id;
        const hasStockShape =
          apiItem?.stock &&
          Number.isSafeInteger(apiItem.stock.current) &&
          apiItem.stock.current >= 0 &&
          Number.isSafeInteger(apiItem.stock.default) &&
          apiItem.stock.default >= 0;
        const hasPrice = Number.isSafeInteger(apiItem?.price) && apiItem.price >= 0;
        if (!Number.isSafeInteger(id) || id <= 0 || !hasStockShape || !hasPrice) continue;
        const key = itemKey(shopId, id);
        if (snapshotByKey.has(key)) {
          throw new Error('The cityshops API returned duplicate shop items; no data was changed.');
        }
        snapshotByKey.set(key, {
          key,
          id,
          name: String(apiItem.name || `Item ${id}`),
          shopId,
          shopName: String(shop.name || `Shop ${shopId}`),
          price: apiItem.price,
          current: apiItem.stock.current,
          defaultStock: apiItem.stock.default,
        });
      }
    }

    const snapshot = [...snapshotByKey.values()];

    if (snapshot.length === 0) {
      throw new Error('The cityshops API schema changed or returned no usable shop items.');
    }

    const previousSnapshotKeys = state.lastSnapshotKeys.length
      ? state.lastSnapshotKeys.filter((key) => !String(key).startsWith('foreign:'))
      : Object.entries(state.items || {})
          .filter(([, item]) => !isForeignItem(item))
          .map(([key]) => key);
    const overlapCount = previousSnapshotKeys.filter((key) => snapshotByKey.has(key)).length;
    if (
      previousSnapshotKeys.length >= 10 &&
      overlapCount < previousSnapshotKeys.length * 0.7
    ) {
      throw new Error('The cityshops API returned a suspiciously incomplete snapshot; no data was changed.');
    }

    const availabilityAlerts = [];
    for (const entry of snapshot) {
      const { key, id, name, shopId, shopName, price, current, defaultStock } = entry;
      const previous = state.items[key];

      if (!previous) {
        state.items[key] = {
          key,
          source: 'city',
          id,
          name,
          shopId,
          shopName,
          price,
          current,
          defaultStock,
          lastSeenAt: observedAt,
          lastChangeAt: observedAt,
          lastRestockAt: null,
          lastSelloutAt: current === 0 ? observedAt : null,
          predictedAt: null,
          stale: false,
          missedSnapshots: 0,
          cycles: [],
          events: [],
        };
        continue;
      }

      const sampleGap = observedAt - asNumber(previous.lastSeenAt, observedAt);
      const reliableTransition = sampleGap >= 0 && sampleGap <= reliableSampleGapMs();
      previous.source = 'city';
      previous.name = name;
      previous.shopName = shopName;
      previous.price = price;
      previous.defaultStock = defaultStock;
      previous.lastSeenAt = observedAt;
      previous.stale = false;
      previous.missedSnapshots = 0;

      const restocked = looksLikeRestock(previous.current, current, defaultStock);
      const soldOut = previous.current > 0 && current === 0;

      if (!reliableTransition) {
        invalidateOpenCycles(previous);
        previous.predictedAt = null;
        addEvent(previous, {
          at: observedAt,
          type: 'observation_gap',
          sampleGap,
        });
      } else {
        recordCycleSampleGap(previous, sampleGap);
      }

      if (
        current === 0 &&
        previous.predictedAt &&
        observedAt > previous.predictedAt + QUARTER_HOUR_MS
      ) {
        addEvent(previous, {
          at: observedAt,
          type: 'prediction_missed',
          predictedAt: previous.predictedAt,
        });
        previous.predictedAt = null;
      }

      if (restocked) {
        if (reliableTransition) {
          closePreviousCycle(previous, observedAt);
          previous.cycles = [
            ...(previous.cycles || []),
            {
              restockedAt: observedAt,
              soldOutAt: null,
              nextRestockedAt: null,
              maxSampleGap: sampleGap,
            },
          ].slice(-MAX_CYCLES);
        } else {
          invalidateOpenCycles(previous);
        }
        previous.lastRestockAt = observedAt;
        previous.predictedAt = null;
        addEvent(previous, {
          at: observedAt,
          type: 'restock',
          from: previous.current,
          to: current,
          uncertain: !reliableTransition,
          sampleGap,
        });
        if (previous.current === 0 && current > 0 && isWatched(key)) {
          availabilityAlerts.push(previous);
        }
      } else if (soldOut) {
        previous.lastSelloutAt = observedAt;
        if (reliableTransition) {
          const activeCycle = [...(previous.cycles || [])]
            .reverse()
            .find((cycle) => !cycle.soldOutAt && !cycle.uncertain);
          if (activeCycle) {
            activeCycle.soldOutAt = observedAt;
            previous.predictedAt = predictCycle(previous, activeCycle);
          }
        } else {
          invalidateOpenCycles(previous);
          previous.predictedAt = null;
        }
        addEvent(previous, {
          at: observedAt,
          type: 'sold_out',
          from: previous.current,
          to: 0,
          uncertain: !reliableTransition,
          sampleGap,
        });
      } else if (previous.current !== current) {
        addEvent(previous, {
          at: observedAt,
          type: 'stock_change',
          from: previous.current,
          to: current,
        });
      }

      if (previous.current !== current) previous.lastChangeAt = observedAt;
      previous.current = current;
    }

    const seenKeys = new Set(snapshotByKey.keys());
    for (const [key, item] of Object.entries(state.items)) {
      if (isForeignItem(item)) continue;
      if (seenKeys.has(key)) continue;
      item.stale = true;
      item.missedSnapshots = asNumber(item.missedSnapshots) + 1;
      item.predictedAt = null;
      invalidateOpenCycles(item);
      if (item.missedSnapshots >= 10 && !isWatched(key)) delete state.items[key];
    }

    state.lastFetchAt = observedAt;
    state.lastSnapshotKeys = [...seenKeys];
    pruneNotifications(observedAt);
    return availabilityAlerts;
  }

  function parseForeignTimestamp(value, { allowDateString = false } = {}) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
      return milliseconds > 0 && milliseconds <= MAX_JAVASCRIPT_DATE_MS
        ? Math.round(milliseconds)
        : null;
    }
    if (!allowDateString || typeof value !== 'string') return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function parseForeignStockResponse(payload, observedAt = Date.now()) {
    if (!payload || !payload.stocks || typeof payload.stocks !== 'object') {
      throw new Error('The foreign-stock provider returned an unexpected response.');
    }

    const countries = [];
    let totalItems = 0;
    for (const [countryCode, country] of Object.entries(FOREIGN_COUNTRIES)) {
      if (!Object.prototype.hasOwnProperty.call(payload.stocks, countryCode)) continue;
      const feedCountry = payload.stocks[countryCode];
      if (!feedCountry || !Array.isArray(feedCountry.stocks)) {
        throw new Error(`The foreign-stock response for ${country.name} was malformed.`);
      }
      if (feedCountry.stocks.length > MAX_FOREIGN_ITEMS_PER_COUNTRY) {
        throw new Error(`The foreign-stock response for ${country.name} contained too many items.`);
      }
      const rawUpdatedAt = parseForeignTimestamp(feedCountry.update);
      if (!rawUpdatedAt) {
        throw new Error(`The foreign-stock response for ${country.name} had no valid update time.`);
      }
      if (rawUpdatedAt > observedAt + MAX_FOREIGN_CLOCK_SKEW_MS) {
        throw new Error(`The foreign-stock response for ${country.name} had a future update time.`);
      }
      const updatedAt = rawUpdatedAt;
      const items = [];
      const seen = new Set();
      for (const feedItem of feedCountry.stocks) {
        const hasRequiredNumbers =
          feedItem?.id !== null &&
          feedItem?.id !== undefined &&
          feedItem?.id !== '' &&
          feedItem?.quantity !== null &&
          feedItem?.quantity !== undefined &&
          feedItem?.quantity !== '' &&
          feedItem?.cost !== null &&
          feedItem?.cost !== undefined &&
          feedItem?.cost !== '';
        const id = Number(feedItem?.id);
        const quantity = Number(feedItem?.quantity);
        const cost = Number(feedItem?.cost);
        const name = typeof feedItem?.name === 'string' ? feedItem.name.trim() : '';
        if (
          !hasRequiredNumbers ||
          !Number.isSafeInteger(id) ||
          id <= 0 ||
          !name ||
          name.length > MAX_FOREIGN_NAME_LENGTH ||
          !Number.isSafeInteger(quantity) ||
          quantity < 0 ||
          !Number.isSafeInteger(cost) ||
          cost < 0
        ) {
          throw new Error(`The foreign-stock response for ${country.name} contained an invalid item.`);
        }
        const key = foreignItemKey(countryCode, id);
        if (seen.has(key)) {
          throw new Error(`The foreign-stock response for ${country.name} contained a duplicate item.`);
        }
        seen.add(key);
        const etaValue = feedItem.nextRestock ?? feedItem.next_restock ?? null;
        items.push({
          key,
          id,
          name,
          quantity,
          cost,
          predictedAt: parseForeignTimestamp(etaValue, { allowDateString: true }),
        });
        totalItems += 1;
        if (totalItems > MAX_FOREIGN_ITEMS) {
          throw new Error('The foreign-stock response contained too many items.');
        }
      }
      if (items.length === 0) {
        throw new Error(`The foreign-stock response for ${country.name} contained no items.`);
      }
      countries.push({ countryCode, country, updatedAt, items });
    }

    if (countries.length === 0) {
      throw new Error('The foreign-stock provider returned no recognized countries.');
    }
    return countries;
  }

  function refreshForeignStaleness(now = Date.now()) {
    for (const item of Object.values(state.items || {})) {
      if (!isForeignItem(item)) continue;
      const sourceUpdatedAt = asNumber(item.sourceUpdatedAt, 0);
      item.stale =
        Boolean(item.missingFromLatest) ||
        !sourceUpdatedAt ||
        now - sourceUpdatedAt > FOREIGN_STALE_MS;
      if (item.stale) item.predictedAt = null;
    }
  }

  function processForeignStockResponse(
    payload,
    provider = 'Community feed',
    observedAt = Date.now(),
    countryProviders = null,
    itemProviders = null,
    itemUpdatedAts = null,
  ) {
    const countries = parseForeignStockResponse(payload, observedAt);
    const availabilityAlerts = [];

    for (const { countryCode, country, updatedAt, items } of countries) {
      const countryProvider = countryProviders?.[countryCode] || provider;
      const previousCountryUpdate = asNumber(state.foreignCountryUpdates[countryCode], 0);
      const countryAdvanced = updatedAt > previousCountryUpdate;
      const countryFresh = observedAt - updatedAt <= FOREIGN_STALE_MS;
      const seenKeys = new Set();
      for (const entry of items) {
        seenKeys.add(entry.key);
        const entryProvider = itemProviders?.[entry.key] || countryProvider;
        const entryUpdatedAt = asNumber(itemUpdatedAts?.[entry.key], updatedAt);
        const entryFresh = observedAt - entryUpdatedAt <= FOREIGN_STALE_MS;
        const previous = state.items[entry.key];
        const predictedAt = entry.quantity === 0 ? entry.predictedAt : null;
        if (!previous) {
          state.items[entry.key] = {
            key: entry.key,
            source: 'foreign',
            id: entry.id,
            name: entry.name,
            countryCode,
            countryName: country.name,
            countryFlag: country.flag,
            shopId: `foreign-${countryCode}`,
            shopName: `${country.flag} ${country.name}`,
            price: entry.cost,
            current: entry.quantity,
            defaultStock: null,
            provider: entryProvider,
            sourceUpdatedAt: entryUpdatedAt,
            lastSeenAt: entryUpdatedAt,
            lastFetchedAt: observedAt,
            lastChangeAt: entryUpdatedAt,
            lastRestockAt: null,
            lastSelloutAt: entry.quantity === 0 ? entryUpdatedAt : null,
            predictedAt,
            stale: !entryFresh,
            missingFromLatest: false,
            missedSnapshots: 0,
            cycles: [],
            events: [],
          };
          continue;
        }

        if (entryUpdatedAt <= asNumber(previous.sourceUpdatedAt, 0)) continue;

        if (!entryFresh) {
          previous.stale = true;
          previous.lastFetchedAt = observedAt;
          continue;
        }

        const oldQuantity = asNumber(previous.current, 0);
        previous.source = 'foreign';
        previous.id = entry.id;
        previous.name = entry.name;
        previous.countryCode = countryCode;
        previous.countryName = country.name;
        previous.countryFlag = country.flag;
        previous.shopId = `foreign-${countryCode}`;
        previous.shopName = `${country.flag} ${country.name}`;
        previous.price = entry.cost;
        previous.defaultStock = null;
        previous.provider = entryProvider;
        previous.sourceUpdatedAt = entryUpdatedAt;
        previous.lastSeenAt = entryUpdatedAt;
        previous.lastFetchedAt = observedAt;
        previous.predictedAt = predictedAt;
        previous.stale = !entryFresh;
        previous.missingFromLatest = false;
        previous.missedSnapshots = 0;
        previous.cycles = [];

        if (oldQuantity !== entry.quantity) {
          previous.lastChangeAt = entryUpdatedAt;
          addEvent(previous, {
            at: entryUpdatedAt,
            type: 'community_stock_change',
            from: oldQuantity,
            to: entry.quantity,
            provider: entryProvider,
          });
        }
        if (oldQuantity === 0 && entry.quantity > 0) {
          previous.lastRestockAt = entryUpdatedAt;
          if (entryFresh && isWatched(entry.key)) availabilityAlerts.push(previous);
        } else if (oldQuantity > 0 && entry.quantity === 0) {
          previous.lastSelloutAt = entryUpdatedAt;
        }
        previous.current = entry.quantity;
      }

      if (countryAdvanced && countryFresh) {
        for (const [key, item] of Object.entries(state.items)) {
          if (!isForeignItem(item) || item.countryCode !== countryCode || seenKeys.has(key)) continue;
          item.stale = true;
          item.missingFromLatest = true;
          item.predictedAt = null;
          item.missedSnapshots = asNumber(item.missedSnapshots) + 1;
          if (item.missedSnapshots >= 10 && !isWatched(key)) delete state.items[key];
        }
      }
      state.foreignCountryUpdates[countryCode] = Math.max(previousCountryUpdate, updatedAt);
    }

    state.lastForeignFetchAt = observedAt;
    state.lastForeignError = null;
    state.foreignProvider = String(provider || 'Community feed');
    refreshForeignStaleness(observedAt);
    pruneNotifications(observedAt);
    return availabilityAlerts;
  }

  function pruneNotifications(now = Date.now()) {
    const keepAfter = now - 14 * 24 * 60 * 60 * 1000;
    state.notified = Object.fromEntries(
      Object.entries(state.notified || {}).filter(([, at]) => Number(at) >= keepAfter),
    );
  }

  function notifyOnce(token, title, text, targetUrl = null) {
    if (
      !state.settings.notifications ||
      state.notified[token] ||
      typeof GM_notification !== 'function'
    ) return;
    try {
      const result = GM_notification({
        title,
        text,
        tag: token,
        timeout: 12000,
        onclick: () => {
          window.focus();
          if (targetUrl) window.location.assign(targetUrl);
          else {
            ui.open = true;
            render();
          }
        },
      });
      state.notified[token] = Date.now();
      Promise.resolve(result).catch(() => {
        delete state.notified[token];
        saveData().catch(() => undefined);
      });
    } catch (_error) {
      // Some mobile userscript hosts do not implement notifications.
    }
  }

  function sendAvailabilityAlerts(items) {
    for (const item of items) {
      const foreign = isForeignItem(item);
      notifyOnce(
        `available:${item.key}:${foreign ? item.sourceUpdatedAt : item.lastRestockAt}`,
        foreign ? `${item.name} reported in stock` : `${item.name} is in stock`,
        foreign
          ? `${formatNumber(item.current)} reported in ${item.countryName} · ${item.provider} · ${formatAge(item.sourceUpdatedAt)}.`
          : `${formatNumber(item.current)} available at ${item.shopName}.`,
        shopUrl(item),
      );
    }
  }

  function sendPredictionAlerts(now = Date.now()) {
    const earlyWindow = Math.max(90000, state.settings.pollSeconds * 1000 + 30000);
    const lateWindow = Math.max(60000, state.settings.pollSeconds * 1000);
    for (const key of state.watched) {
      const item = state.items[key];
      if (!item || item.stale || item.current > 0 || !item.predictedAt) continue;
      const lead = item.predictedAt - now;
      if (lead <= earlyWindow && lead >= -lateWindow) {
        const foreign = isForeignItem(item);
        const confidence = foreign ? null : predictionConfidence(item).label;
        notifyOnce(
          `predicted:${item.key}:${item.predictedAt}`,
          foreign ? `${item.name}: community restock estimate` : `${item.name} may restock soon`,
          foreign
            ? `${item.provider} estimates ${formatTct(item.predictedAt)} for ${item.countryName}.`
            : `Estimated ${formatTct(item.predictedAt)} (${confidence} confidence).`,
          shopUrl(item),
        );
      }
    }
  }

  function apiRequest(key, { bypassCache = false, url = API_URL } = {}) {
    return new Promise((resolve, reject) => {
      const requestUrl = bypassCache
        ? `${url}&timestamp=${Math.floor(Date.now() / 1000)}`
        : url;
      let requestHandle = null;
      let timeoutId = null;
      let settled = false;
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      };
      requestHandle = GM_xmlhttpRequest({
        method: 'GET',
        url: requestUrl,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: `ApiKey ${key}`,
        },
        timeout: 20000,
        onload: (response) => {
          try {
            const finalOrigin = new URL(response.finalUrl || requestUrl).origin;
            if (finalOrigin !== 'https://api.torn.com') {
              rejectOnce(new Error('The Torn API unexpectedly redirected to another site.'));
              return;
            }
          } catch (_error) {
            rejectOnce(new Error('The Torn API returned an invalid response URL.'));
            return;
          }
          let data;
          try {
            data = JSON.parse(response.responseText || '{}');
          } catch (_error) {
            rejectOnce(new Error('Torn returned a response that was not valid JSON.'));
            return;
          }

          if (response.status < 200 || response.status >= 300 || data.error) {
            const apiError = data.error?.error || data.error?.message || data.error;
            const error = new Error(
              typeof apiError === 'string'
                ? apiError
                : `Torn API request failed (${response.status || 'unknown status'}).`,
            );
            error.apiCode = Number.isFinite(Number(data.error?.code))
              ? Number(data.error.code)
              : null;
            error.httpStatus = response.status || null;
            rejectOnce(error);
            return;
          }
          resolveOnce(data);
        },
        ontimeout: () => rejectOnce(new Error('The Torn API request timed out.')),
        onerror: () => rejectOnce(new Error('The Torn API could not be reached.')),
        onabort: () => rejectOnce(new Error('The Torn API request was aborted.')),
      });
      if (!settled) {
        timeoutId = setTimeout(() => {
          rejectOnce(new Error('The Torn API request timed out.'));
          requestHandle?.abort?.();
        }, 20000);
      }
    });
  }

  function decodePublicJsonResponse(response, providerName) {
    const responseText = String(response?.responseText || '');
    if (responseText.length > MAX_FOREIGN_RESPONSE_CHARS) {
      throw new Error(`${providerName} returned an unexpectedly large response.`);
    }
    let data;
    try {
      data = JSON.parse(responseText || '{}');
    } catch (_error) {
      throw new Error(`${providerName} returned data that was not valid JSON.`);
    }
    const responseStatus = Number(response?.status);
    if (!Number.isFinite(responseStatus) || responseStatus < 200 || responseStatus >= 300) {
      throw new Error(`${providerName} request failed (${response?.status || 'unknown status'}).`);
    }
    return data;
  }

  function pdaPublicJsonRequest(url, providerName) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error(String(error || 'Unknown error')));
      };
      let request;
      try {
        request = globalThis.PDA_httpGet(url, { Accept: 'application/json' });
      } catch (error) {
        rejectOnce(error);
        return;
      }
      timeoutId = setTimeout(
        () => rejectOnce(new Error(`${providerName} request timed out.`)),
        FOREIGN_REQUEST_TIMEOUT_MS,
      );
      Promise.resolve(request).then(
        (response) => {
          try {
            resolveOnce(decodePublicJsonResponse(response, providerName));
          } catch (error) {
            rejectOnce(error);
          }
        },
        () => rejectOnce(new Error(`${providerName} could not be reached.`)),
      );
    });
  }

  function publicJsonRequest(url, providerName) {
    if (typeof globalThis.PDA_httpGet === 'function') {
      return pdaPublicJsonRequest(url, providerName);
    }
    return new Promise((resolve, reject) => {
      let requestHandle = null;
      let timeoutId = null;
      let settled = false;
      let rejectedForSize = false;
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      };
      requestHandle = GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/json' },
        anonymous: true,
        timeout: FOREIGN_REQUEST_TIMEOUT_MS,
        onprogress: (progress) => {
          const loaded = Number(progress?.loaded);
          if (
            !Number.isFinite(loaded) ||
            loaded <= MAX_FOREIGN_RESPONSE_CHARS ||
            rejectedForSize
          ) return;
          rejectedForSize = true;
          rejectOnce(new Error(`${providerName} returned an unexpectedly large response.`));
          requestHandle?.abort?.();
        },
        onload: (response) => {
          if (settled || rejectedForSize) return;
          try {
            resolveOnce(decodePublicJsonResponse(response, providerName));
          } catch (error) {
            rejectOnce(error);
          }
        },
        ontimeout: () => rejectOnce(new Error(`${providerName} request timed out.`)),
        onerror: () => rejectOnce(new Error(`${providerName} could not be reached.`)),
        onabort: () => {
          if (!rejectedForSize) rejectOnce(new Error(`${providerName} request was aborted.`));
        },
      });
      if (!settled) {
        timeoutId = setTimeout(() => {
          rejectOnce(new Error(`${providerName} request timed out.`));
          requestHandle?.abort?.();
        }, FOREIGN_REQUEST_TIMEOUT_MS);
      }
    });
  }

  function mergeForeignCandidates(candidates) {
    const choicesByCountry = new Map();
    for (const candidate of candidates) {
      for (const country of candidate.countries) {
        const choices = choicesByCountry.get(country.countryCode) || [];
        choices.push({ candidate, country });
        choicesByCountry.set(country.countryCode, choices);
      }
    }
    const stocks = {};
    const countryProviders = {};
    const itemProviders = {};
    const itemUpdatedAts = {};
    const usedProviders = new Set();
    for (const [countryCode, choices] of choicesByCountry) {
      choices.sort((left, right) => right.country.updatedAt - left.country.updatedAt);
      const newest = choices[0];
      const itemChoices = new Map();
      for (const choice of choices) {
        for (const feedItem of choice.candidate.payload.stocks[countryCode].stocks) {
          const existing = itemChoices.get(Number(feedItem.id));
          if (!existing || choice.country.updatedAt > existing.country.updatedAt) {
            itemChoices.set(Number(feedItem.id), { ...choice, feedItem });
          }
        }
      }
      stocks[countryCode] = {
        ...newest.candidate.payload.stocks[countryCode],
        stocks: [...itemChoices.values()].map((choice) => choice.feedItem),
      };
      countryProviders[countryCode] = newest.candidate.feed.name;
      for (const choice of itemChoices.values()) {
        const key = foreignItemKey(countryCode, Number(choice.feedItem.id));
        itemProviders[key] = choice.candidate.feed.name;
        itemUpdatedAts[key] = choice.country.updatedAt;
        usedProviders.add(choice.candidate.feed.name);
      }
    }
    const provider = [...usedProviders].join(' + ') || 'Community feed';
    return { payload: { stocks }, provider, countryProviders, itemProviders, itemUpdatedAts };
  }

  async function fetchForeignStock(observedAt = Date.now()) {
    const results = await Promise.allSettled(
      FOREIGN_FEEDS.map(async (feed) => {
        const payload = await publicJsonRequest(feed.url, feed.name);
        const countries = parseForeignStockResponse(payload, observedAt);
        return { feed, payload, countries };
      }),
    );
    const candidates = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    if (!candidates.length) {
      const errors = results.map((result) =>
        result.status === 'rejected'
          ? result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
          : '',
      );
      throw new Error(`Foreign stock is temporarily unavailable. ${errors.filter(Boolean).join(' ')}`);
    }

    return mergeForeignCandidates(candidates);
  }

  function isPublicOnlyKeyInfo(payload) {
    return payload?.info?.access?.type === 'Public Only';
  }

  async function connectKey(candidate) {
    if (pollInFlight) return;
    pollInFlight = true;
    status = { kind: 'loading', text: 'Testing the Public key…' };
    render();

    try {
      const keyInfo = await apiRequest(candidate, {
        bypassCache: true,
        url: KEY_INFO_URL,
      });
      if (!isPublicOnlyKeyInfo(keyInfo)) {
        const accessType = keyInfo?.info?.access?.type;
        throw new Error(
          accessType
            ? `This is a ${accessType} key. Create a Public Only key for Stock Watch.`
            : 'Torn did not return a verifiable Public Only key type.',
        );
      }
      await Promise.all([mergeLatestPreferences(), mergeLatestData()]);
      const observedAt = Date.now();
      const shouldFetchForeign =
        !state.lastForeignAttemptAt ||
        observedAt - state.lastForeignAttemptAt >= FOREIGN_POLL_MS;
      if (shouldFetchForeign) state.lastForeignAttemptAt = observedAt;
      const [cityResult, foreignResult] = await Promise.allSettled([
        apiRequest(candidate, { bypassCache: true }),
        shouldFetchForeign ? fetchForeignStock(observedAt) : Promise.resolve(null),
      ]);
      if (cityResult.status === 'rejected') throw cityResult.reason;
      const alerts = processStockResponse(cityResult.value, observedAt);
      let foreignWarning = '';
      let foreignFailed = false;
      if (foreignResult.status === 'fulfilled' && foreignResult.value) {
        const foreignAlerts = processForeignStockResponse(
          foreignResult.value.payload,
          foreignResult.value.provider,
          observedAt,
          foreignResult.value.countryProviders,
          foreignResult.value.itemProviders,
          foreignResult.value.itemUpdatedAts,
        );
        alerts.push(...foreignAlerts);
      } else if (shouldFetchForeign) {
        refreshForeignStaleness(observedAt);
        state.lastForeignError = safeErrorMessage(foreignResult.reason);
        foreignFailed = true;
        foreignWarning = foreignItemCount()
          ? ' · using cached foreign reports'
          : ' · foreign feeds unavailable';
      } else if (state.lastForeignError) {
        foreignFailed = true;
        foreignWarning = foreignItemCount()
          ? ' · using cached foreign reports'
          : ' · foreign feeds unavailable';
      } else {
        foreignWarning = ' · foreign feed checked recently';
      }
      apiKey = candidate;
      status = {
        kind: foreignFailed ? 'warning' : 'ok',
        text: `City connected${foreignWarning || ` · ${foreignItemCount()} foreign items loaded`}`,
      };
      retryAfter = 0;
      sendAvailabilityAlerts(alerts);
      sendPredictionAlerts();
      await saveData();
      await gmSet(API_KEY_STORAGE, apiKey);
      schedulePoll();
    } catch (error) {
      apiKey = '';
      await gmDelete(API_KEY_STORAGE).catch(() => undefined);
      await saveData().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      status = { kind: 'error', text: `${message} The key was not saved.` };
    } finally {
      pollInFlight = false;
      render();
    }
  }

  function claimPollingLock() {
    const now = Date.now();
    const ttl = 90000;
    try {
      const existing = JSON.parse(localStorage.getItem(TAB_LOCK_KEY) || 'null');
      if (existing?.owner !== TAB_ID && existing?.expiresAt > now) return false;
      localStorage.setItem(TAB_LOCK_KEY, JSON.stringify({ owner: TAB_ID, expiresAt: now + ttl }));
      const claimed = JSON.parse(localStorage.getItem(TAB_LOCK_KEY) || 'null');
      return claimed?.owner === TAB_ID;
    } catch (_error) {
      // If storage is blocked, polling still works; duplicate-tab suppression simply does not.
    }
    return true;
  }

  function releasePollingLock() {
    try {
      const existing = JSON.parse(localStorage.getItem(TAB_LOCK_KEY) || 'null');
      if (existing?.owner === TAB_ID) localStorage.removeItem(TAB_LOCK_KEY);
    } catch (_error) {
      // Best-effort fallback for browsers without the Web Locks API.
    }
  }

  function anotherTabRecentlyPolled() {
    try {
      const lastPollAt = Number(localStorage.getItem(TAB_LAST_POLL_KEY));
      const cooldown = Math.max(15000, state.settings.pollSeconds * 900);
      return Number.isFinite(lastPollAt) && Date.now() - lastPollAt < cooldown;
    } catch (_error) {
      return false;
    }
  }

  function markSuccessfulPoll() {
    try {
      localStorage.setItem(TAB_LAST_POLL_KEY, String(Date.now()));
    } catch (_error) {
      // Polling still works if page storage is unavailable.
    }
  }

  async function withPollingLock(callback) {
    if (
      typeof navigator !== 'undefined' &&
      navigator.locks &&
      typeof navigator.locks.request === 'function'
    ) {
      let acquired = false;
      try {
        await navigator.locks.request(
          TAB_LOCK_KEY,
          { mode: 'exclusive', ifAvailable: true },
          async (lock) => {
            if (!lock) return;
            acquired = true;
            await callback();
          },
        );
        return acquired;
      } catch (error) {
        if (acquired) throw error;
        // Fall through to the localStorage lease on older or restricted hosts.
      }
    }

    if (!claimPollingLock()) return false;
    try {
      await callback();
      return true;
    } finally {
      releasePollingLock();
    }
  }

  async function poll({ force = false } = {}) {
    if (!apiKey || pollInFlight || Date.now() < retryAfter) return;
    const acquired = await withPollingLock(async () => {
      if (!apiKey || pollInFlight || Date.now() < retryAfter) return;
      if (!force && anotherTabRecentlyPolled()) return;
      pollInFlight = true;
      status = { kind: 'loading', text: 'Checking city and foreign stock…' };

      try {
        await Promise.all([mergeLatestPreferences(), mergeLatestData()]);
        const observedAt = Date.now();
        const shouldFetchForeign =
          force ||
          !state.lastForeignAttemptAt ||
          observedAt - state.lastForeignAttemptAt >= FOREIGN_POLL_MS;
        if (shouldFetchForeign) state.lastForeignAttemptAt = observedAt;
        const [cityResult, foreignResult] = await Promise.allSettled([
          apiRequest(apiKey, { bypassCache: force }),
          shouldFetchForeign ? fetchForeignStock(observedAt) : Promise.resolve(null),
        ]);
        const alerts = [];
        let cityError = null;
        let foreignError = null;

        if (cityResult.status === 'fulfilled') {
          try {
            alerts.push(...processStockResponse(cityResult.value, observedAt));
          } catch (error) {
            cityError = error;
          }
        } else {
          cityError = cityResult.reason;
        }

        if (shouldFetchForeign) {
          if (foreignResult.status === 'fulfilled') {
            try {
              alerts.push(
                ...processForeignStockResponse(
                  foreignResult.value.payload,
                  foreignResult.value.provider,
                  observedAt,
                  foreignResult.value.countryProviders,
                  foreignResult.value.itemProviders,
                  foreignResult.value.itemUpdatedAts,
                ),
              );
            } catch (error) {
              foreignError = error;
            }
          } else {
            foreignError = foreignResult.reason;
          }
        }
        if (foreignError) state.lastForeignError = safeErrorMessage(foreignError);
        refreshForeignStaleness(observedAt);
        sendAvailabilityAlerts(alerts);
        sendPredictionAlerts(observedAt);
        await saveData();

        if (cityError) throw cityError;
        status = state.lastForeignError
          ? {
              kind: 'warning',
              text: foreignItemCount()
                ? 'City updated · using cached foreign reports'
                : 'City updated · foreign feeds unavailable',
            }
          : {
              kind: 'ok',
              text: force
                ? `City & ${foreignItemCount()} foreign items refreshed`
                : 'Stock updated',
            };
        retryAfter = 0;
        markSuccessfulPoll();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (PERMANENT_KEY_ERROR_CODES.has(error?.apiCode)) {
          apiKey = '';
          await gmDelete(API_KEY_STORAGE).catch(() => undefined);
          status = { kind: 'error', text: `${message} Enter a valid Public key.` };
          retryAfter = 0;
        } else {
          status = { kind: 'error', text: message };
          const delay = error?.apiCode === 8 ? 5 * 60 * 1000 : error?.apiCode === 5 ? 2 * 60 * 1000 : 30000;
          retryAfter = Date.now() + delay;
        }
      } finally {
        pollInFlight = false;
        render();
      }
    });

    if (!acquired && force) {
      status = { kind: 'idle', text: 'Another Torn tab is already checking' };
      render();
    }
  }

  function schedulePoll(delay = state.settings.pollSeconds * 1000) {
    clearTimeout(pollTimer);
    if (!apiKey) return;
    pollTimer = setTimeout(async () => {
      await poll();
      schedulePoll();
    }, delay);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(asNumber(value));
  }

  function formatMoney(value) {
    return `$${formatNumber(value)}`;
  }

  function formatTct(timestamp, now = Date.now()) {
    const numericTimestamp = Number(timestamp);
    const date = new Date(numericTimestamp);
    if (!Number.isFinite(numericTimestamp) || !Number.isFinite(date.getTime())) {
      return 'unknown time';
    }
    const today = new Date(now);
    const sameUtcDate =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        ...(sameUtcDate ? {} : { year: 'numeric', month: 'short', day: '2-digit' }),
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
    } catch (_error) {
      return 'unknown time';
    }
  }

  function formatAge(timestamp, now = Date.now()) {
    if (!timestamp) return 'never';
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function predictionText(item, now = Date.now()) {
    if (isForeignItem(item)) {
      const reportAge = formatAge(item.sourceUpdatedAt, now);
      const provider = item.provider || 'Community feed';
      if (item.stale || now - asNumber(item.sourceUpdatedAt, 0) > FOREIGN_STALE_MS) {
        return {
          text: `Stale community report · ${reportAge} · ${provider}`,
          className: 'stale',
        };
      }
      if (item.current > 0) {
        return {
          text: `Reported available · ${reportAge} · ${provider}`,
          className: 'available',
        };
      }
      if (item.predictedAt) {
        const passed = now > item.predictedAt + Math.max(60000, state.settings.pollSeconds * 1000);
        return {
          text: `${passed ? 'Community estimate passed' : `Community est. ${formatTct(item.predictedAt)}`} · ${provider} · report ${reportAge}`,
          className: passed ? 'overdue' : 'estimate',
        };
      }
      return { text: `Reported out of stock · ${reportAge} · ${provider}`, className: 'learning' };
    }
    if (item.stale) {
      return { text: `Not in latest snapshot · seen ${formatAge(item.lastSeenAt, now)}`, className: 'stale' };
    }
    if (item.current > 0) return { text: 'Available now', className: 'available' };
    if (!item.predictedAt) return { text: 'Learning restock cycle', className: 'learning' };
    const confidence = predictionConfidence(item);
    const overdue = now > item.predictedAt + Math.max(60000, state.settings.pollSeconds * 1000);
    const evidence = confidence.samples
      ? `${confidence.samples} completed cycle${confidence.samples === 1 ? '' : 's'}`
      : 'wiki formula';
    return {
      text: `${overdue ? 'Expected by' : 'Est.'} ${formatTct(item.predictedAt)} · ${confidence.label} · ${evidence}`,
      className: overdue ? 'overdue' : 'estimate',
    };
  }

  function allItems() {
    return Object.values(state.items || {}).filter((item) => item && item.key);
  }

  function sortedItems(items) {
    return items.slice().sort((a, b) => {
      const availability = Number(!b.stale && b.current > 0) - Number(!a.stale && a.current > 0);
      if (availability) return availability;
      const freshness = Number(Boolean(a.stale)) - Number(Boolean(b.stale));
      if (freshness) return freshness;
      return `${a.countryName || a.shopName} ${a.name}`.localeCompare(
        `${b.countryName || b.shopName} ${b.name}`,
      );
    });
  }

  function renderItem(item, watched) {
    const foreign = isForeignItem(item);
    const prediction = predictionText(item);
    const available = !item.stale && item.current > 0;
    const percentage = item.defaultStock > 0 ? clamp((item.current / item.defaultStock) * 100, 0, 100) : 0;
    const stockDetails = foreign
      ? `<div class="stock-line foreign-stock"><span><b>${formatNumber(item.current)}</b> reported</span><span>${formatMoney(item.price)}</span></div>
         <div class="community-note">Community data can be delayed or wrong; availability is not guaranteed.</div>`
      : `<div class="stock-line"><span><b>${formatNumber(item.current)}</b> / ${formatNumber(item.defaultStock)}</span><span>${formatMoney(item.price)}</span></div>
         <div class="stock-bar"><i style="width:${percentage.toFixed(1)}%"></i></div>`;
    return `
      <article class="item-card ${available ? 'has-stock' : 'empty'} ${item.stale ? 'stale-card' : ''}">
        <div class="item-topline">
          <div class="item-title-wrap">
            <strong class="item-title">${escapeHtml(item.name)}</strong>
            <span class="shop-name">${escapeHtml(item.shopName)}</span>
          </div>
          <button class="watch-button ${watched ? 'watching' : ''}" data-action="toggle-watch" data-key="${escapeHtml(item.key)}" aria-label="${watched ? 'Stop watching' : 'Watch'} ${escapeHtml(item.name)}" title="${watched ? 'Stop watching' : 'Watch this item'}">${watched ? '★' : '☆'}</button>
        </div>
        ${stockDetails}
        <div class="item-footer"><div class="prediction ${prediction.className}">${escapeHtml(prediction.text)}</div><a class="shop-link" href="${shopUrl(item)}">${foreign ? 'Open travel' : 'Open shop'} →</a></div>
      </article>`;
  }

  function setupMarkup() {
    return `
      <section class="setup">
        <h2>Connect the official Torn API</h2>
        <p>Enter a <b>Public Only</b> API key—not a Minimal, Limited, or Full key. It stays inside your userscript manager and is sent only to <code>api.torn.com</code>. Foreign stock is fetched separately, without your key, from community feeds.</p>
        <label class="field-label" for="tcsw-api-key">Public API key</label>
        <input id="tcsw-api-key" class="text-input" type="password" autocomplete="off" placeholder="Paste your key" />
        <div class="setup-status ${escapeHtml(status.kind)}" role="status" aria-live="polite">${status.kind !== 'idle' ? escapeHtml(status.text) : ''}</div>
        <button class="primary wide" data-action="save-key">Save &amp; test</button>
        <a class="subtle-link" href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener noreferrer">Create or manage a Torn API key</a>
        <details class="tos">
          <summary>API usage &amp; privacy</summary>
          <dl>
            <div><dt>Data storage</dt><dd>Only locally in your browser/userscript manager</dd></div>
            <div><dt>Data sharing</dt><dd>Keyless foreign-stock requests go to Prometheus Bot and YATA; their newest valid country/item reports are combined, and both services can receive normal connection metadata such as your IP address</dd></div>
            <div><dt>Purpose</dt><dd>Competitive advantage — personal city and foreign stock monitoring, alerts, and estimates</dd></div>
            <div><dt>Key storage</dt><dd>Stored locally; sent only to Torn and never to a community feed</dd></div>
            <div><dt>Key access</dt><dd>Public Only required; setup verifies it with <code>key → info</code>, then monitoring uses <code>torn → cityshops</code></dd></div>
            <div><dt>Foreign data</dt><dd>Crowdsourced, potentially delayed or incorrect, and never a guarantee of availability</dd></div>
          </dl>
        </details>
      </section>`;
  }

  function emptyMarkup(view, hasData) {
    if (!hasData) {
      return '<div class="empty-state"><b>No shop data yet.</b><span>Use “Refresh” to take the first snapshot.</span></div>';
    }
    if (view === 'watched') {
      const abroadCount = foreignItemCount();
      const loadedNote = abroadCount
        ? `${formatNumber(abroadCount)} foreign items are loaded. `
        : '';
      return `<div class="empty-state"><b>No watched items.</b><span>${escapeHtml(loadedNote)}Open Browse and tap ☆ beside an item.</span></div>`;
    }
    return '<div class="empty-state"><b>No matching items.</b><span>Try a different search or location.</span></div>';
  }

  function settingsMarkup() {
    const notificationAvailable = typeof GM_notification === 'function';
    const abroadCount = foreignItemCount();
    const foreignSummary = abroadCount
      ? `${formatNumber(abroadCount)} items loaded · newest report ${formatAge(latestForeignUpdate())}`
      : 'No foreign items have loaded yet.';
    return `
      <section class="settings-view">
        <h2>Settings</h2>
        <div class="feed-health ${state.lastForeignError ? 'has-warning' : ''}">
          <b>Foreign feed</b>
          <span>${escapeHtml(foreignSummary)}</span>
          ${state.lastForeignError ? `<small>Last error: ${escapeHtml(state.lastForeignError)}</small>` : `<small>${escapeHtml(state.foreignProvider || 'Prometheus Bot + YATA')}</small>`}
        </div>
        <label class="setting-row">
          <span><b>Restock notifications</b><small>${notificationAvailable ? 'City alerts use Torn data; foreign alerts are labeled community reports.' : 'Notifications are unavailable in this userscript host.'}</small></span>
          <input type="checkbox" data-setting="notifications" ${state.settings.notifications ? 'checked' : ''} ${notificationAvailable ? '' : 'disabled'} />
        </label>
        <label class="setting-row">
          <span><b>Check interval</b><small>City uses this interval. Automatic foreign checks run no faster than once a minute; Refresh retries immediately.</small></span>
          <select data-setting="pollSeconds">
            ${[30, 60, 120, 300]
              .map(
                (seconds) => `<option value="${seconds}" ${state.settings.pollSeconds === seconds ? 'selected' : ''}>${seconds < 60 ? `${seconds} sec` : `${seconds / 60} min`}</option>`,
              )
              .join('')}
          </select>
        </label>
        <div class="settings-actions">
          <button data-action="export-history">Export history</button>
          <button data-action="clear-history">Clear history</button>
          <button class="danger" data-action="forget-key">Forget API key</button>
        </div>
        <div class="privacy-note"><b>Local data, two community feeds</b><span>No analytics, advertisements, auto-buying, or page scraping. Your Torn key is never sent to Prometheus Bot or YATA.</span></div>
      </section>`;
  }

  function itemSource(item) {
    return isForeignItem(item) ? 'foreign' : 'city';
  }

  function locationFilterKey(item) {
    return isForeignItem(item) ? `foreign:${item.countryCode}` : `city:${item.shopId}`;
  }

  function locationLabel(item) {
    return isForeignItem(item)
      ? `Abroad — ${item.countryName}`
      : `City — ${item.shopName}`;
  }

  function latestForeignUpdate() {
    const updates = Object.values(state.foreignCountryUpdates || {}).filter(Number.isFinite);
    return updates.length ? Math.max(...updates) : null;
  }

  function appMarkup() {
    const items = allItems();
    const abroadCount = foreignItemCount();
    const sourceItems = ui.source === 'all'
      ? items
      : items.filter((item) => itemSource(item) === ui.source);
    const locations = [
      ...new Map(
        sourceItems.map((item) => [locationFilterKey(item), locationLabel(item)]),
      ).entries(),
    ].sort((a, b) => a[1].localeCompare(b[1]));

    let content;
    if (ui.view === 'settings') {
      content = settingsMarkup();
    } else {
      let visible = ui.view === 'watched' ? items.filter((item) => isWatched(item.key)) : items;
      if (ui.source !== 'all') {
        visible = visible.filter((item) => itemSource(item) === ui.source);
      }
      const query = ui.query.trim().toLowerCase();
      if (query) {
        visible = visible.filter((item) =>
          `${item.name} ${item.shopName} ${item.countryName || ''} ${item.provider || ''}`
            .toLowerCase()
            .includes(query),
        );
      }
      if (ui.shop !== 'all') {
        visible = visible.filter((item) => locationFilterKey(item) === ui.shop);
      }
      visible = sortedItems(visible);

      content = `
        <div class="filters">
          <input class="search-input" type="search" data-action="search" value="${escapeHtml(ui.query)}" placeholder="Search items or locations" />
          <select data-action="source-filter">
            <option value="all" ${ui.source === 'all' ? 'selected' : ''}>City + foreign</option>
            <option value="city" ${ui.source === 'city' ? 'selected' : ''}>City only</option>
            <option value="foreign" ${ui.source === 'foreign' ? 'selected' : ''}>Foreign only</option>
          </select>
          <select data-action="shop-filter">
            <option value="all">All locations</option>
            ${locations
              .map(
                ([id, name]) => `<option value="${escapeHtml(id)}" ${ui.shop === id ? 'selected' : ''}>${escapeHtml(name)}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="item-list">
          ${visible.length ? visible.map((item) => renderItem(item, isWatched(item.key))).join('') : emptyMarkup(ui.view, items.length > 0)}
        </div>`;
    }

    return `
      <div class="status-row">
        <span class="status-dot ${escapeHtml(status.kind)}"></span>
        <span class="status-text">${escapeHtml(status.text)}</span>
        <span class="data-age">City ${escapeHtml(formatAge(state.lastFetchAt))} · Abroad ${escapeHtml(formatNumber(abroadCount))} / ${escapeHtml(formatAge(latestForeignUpdate()))}</span>
        <button class="icon-button" data-action="refresh" title="Refresh now" ${pollInFlight ? 'disabled' : ''}>↻</button>
      </div>
      <nav class="tabs" aria-label="Stock Watch views">
        <button class="${ui.view === 'watched' ? 'active' : ''}" data-action="view" data-view="watched">Watched <span>${state.watched.length}</span></button>
        <button class="${ui.view === 'browse' ? 'active' : ''}" data-action="view" data-view="browse">Browse</button>
        <button class="${ui.view === 'settings' ? 'active' : ''}" data-action="view" data-view="settings">Settings</button>
      </nav>
      ${content}`;
  }

  function installHeaderLauncherStyle() {
    if (document.getElementById(HEADER_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HEADER_STYLE_ID;
    style.textContent = `
      #${HEADER_LAUNCHER_ID} {
        position: relative !important; display: inline-flex !important; align-items: center !important;
        justify-content: center !important; flex: 0 0 auto !important; margin: 0 !important;
        padding: 0 !important; border: 0 !important; list-style: none !important;
        box-sizing: border-box !important; width: 34px !important; min-width: 34px !important;
        height: 34px !important; min-height: 34px !important; overflow: visible !important;
        box-shadow: none !important;
        background: transparent !important; background-image: none !important;
      }
      #${HEADER_LAUNCHER_ID}::before, #${HEADER_LAUNCHER_ID}::after {
        display: none !important; content: none !important;
      }
      #${HEADER_LAUNCHER_ID} .tcsw-status-button {
        all: unset !important; position: relative !important; box-sizing: border-box !important;
        display: inline-flex !important; align-items: center !important; justify-content: center !important;
        width: 34px !important; height: 34px !important; margin: 0 !important; padding: 0 !important;
        border-radius: 7px !important; color: #7d858f !important; cursor: pointer !important;
        opacity: .92 !important; transition: color .12s ease, background-color .12s ease !important;
        -webkit-tap-highlight-color: transparent !important;
      }
      #${HEADER_LAUNCHER_ID} .tcsw-status-button:hover,
      #${HEADER_LAUNCHER_ID} .tcsw-status-button:focus-visible,
      #${HEADER_LAUNCHER_ID} .tcsw-status-button[aria-expanded="true"] {
        color: #8b5cf6 !important; background: rgba(139, 92, 246, .12) !important;
        outline: none !important;
      }
      #${HEADER_LAUNCHER_ID} .tcsw-status-button:focus-visible {
        box-shadow: inset 0 0 0 2px rgba(139, 92, 246, .6) !important;
      }
      #${HEADER_LAUNCHER_ID} .tcsw-status-button svg {
        display: block !important; width: 21px !important; height: 21px !important;
        overflow: visible !important; pointer-events: none !important;
      }
      #${HEADER_LAUNCHER_ID} .tcsw-status-button::after {
        position: absolute !important; top: 4px !important; right: 4px !important;
        width: 6px !important; height: 6px !important; border: 1px solid rgba(17,20,26,.8) !important;
        border-radius: 50% !important; background: #f59e0b !important; content: none !important;
      }
      #${HEADER_LAUNCHER_ID}[data-health="warning"] .tcsw-status-button::after,
      #${HEADER_LAUNCHER_ID}[data-health="error"] .tcsw-status-button::after {
        content: "" !important;
      }
      #${HEADER_LAUNCHER_ID}[data-health="error"] .tcsw-status-button::after {
        background: #fb7185 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function headerElementIsVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) return true;
    return Boolean(
      element.offsetWidth ||
      element.offsetHeight ||
      element.getClientRects?.().length,
    );
  }

  function headerStatusLists() {
    const selectors = [
      '#sidebarroot ul[class*="status-icons_"]',
      '#sidebarroot ul[class*="statusIcons_"]',
      '#sidebar ul[class*="status-icons_"]',
      '#sidebar ul[class*="statusIcons_"]',
      '[class*="user-information_"] ul[class*="status-icons_"]',
      '[class*="user-information_"] ul[class*="statusIcons_"]',
    ];
    const lists = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
    return lists.sort((left, right) => {
      const score = (list) => {
        const visible = headerElementIsVisible(list) ? 20 : 0;
        const hasBazaar = list.querySelector('a[href*="bazaar.php"]') ? 100 : 0;
        const inSidebarRoot = list.closest('#sidebarroot') ? 40 : 0;
        return hasBazaar + inSidebarRoot + visible;
      };
      return score(right) - score(left);
    });
  }

  function findHeaderLauncherContainer() {
    const statusLists = headerStatusLists();
    const visibleStatusList = statusLists.find(headerElementIsVisible);
    if (visibleStatusList) return { container: visibleStatusList, statusList: true };

    const mobileFallbacks = [
      document.querySelector('.header-menu.left[class*="leftMenu_"].dropdown-menu'),
      document.querySelector('.header-buttons-wrapper ul.toolbar'),
      document.querySelector('.header-buttons-wrapper'),
    ].filter(Boolean);
    const visibleMobileFallback = mobileFallbacks.find(headerElementIsVisible);
    if (visibleMobileFallback) {
      return { container: visibleMobileFallback, statusList: false };
    }

    if (statusLists[0]) return { container: statusLists[0], statusList: true };
    return mobileFallbacks[0]
      ? { container: mobileFallbacks[0], statusList: false }
      : null;
  }

  function createNativeLauncher(container) {
    const item = document.createElement(container.matches('ul, ol') ? 'li' : 'span');
    item.id = HEADER_LAUNCHER_ID;
    item.dataset.stockWatch = 'launcher';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tcsw-status-button';
    button.setAttribute('aria-label', 'Open Stock Watch');
    button.setAttribute('aria-controls', 'torn-city-stock-watch-panel');
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 19.5V4.5M4 19.5H21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M7 16v-4.5h3V16H7Zm5 0V7h3v9h-3Zm5 0V9.5h3V16h-3Z" fill="currentColor"/>
      </svg>`;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      ui.open = !ui.open;
      render();
    });
    item.appendChild(button);
    return item;
  }

  function updateNativeLauncherState() {
    const item = nativeLauncher?.isConnected
      ? nativeLauncher
      : document.getElementById(HEADER_LAUNCHER_ID);
    if (!item) return;
    nativeLauncher = item;
    const button = item.querySelector('.tcsw-status-button');
    const health = status.kind === 'error' ? 'error' : state.lastForeignError ? 'warning' : 'ok';
    item.dataset.health = health;
    button?.setAttribute('aria-expanded', String(ui.open));
    button?.setAttribute('aria-label', `${ui.open ? 'Close' : 'Open'} Stock Watch`);
    if (button) {
      button.title = state.lastForeignError
        ? `Stock Watch — foreign feed warning: ${state.lastForeignError}`
        : 'Stock Watch';
    }
  }

  function ensureHeaderLauncher() {
    installHeaderLauncherStyle();
    const target = findHeaderLauncherContainer();
    if (!target) return false;

    nativeLauncher = document.getElementById(HEADER_LAUNCHER_ID) || nativeLauncher;
    if (!nativeLauncher || nativeLauncher.tagName !== (target.container.matches('ul, ol') ? 'LI' : 'SPAN')) {
      nativeLauncher?.remove();
      nativeLauncher = createNativeLauncher(target.container);
    }

    if (target.statusList) {
      const bazaarLink = target.container.querySelector('a[href*="bazaar.php"]');
      const bazaarItem = bazaarLink?.closest('li');
      if (bazaarItem?.parentElement === target.container) {
        if (
          nativeLauncher.parentElement !== target.container ||
          nativeLauncher.previousElementSibling !== bazaarItem
        ) {
          target.container.insertBefore(nativeLauncher, bazaarItem.nextElementSibling);
        }
      } else if (
        nativeLauncher.parentElement !== target.container ||
        target.container.firstElementChild !== nativeLauncher
      ) {
        target.container.prepend(nativeLauncher);
      }
    } else if (nativeLauncher.parentElement !== target.container) {
      target.container.appendChild(nativeLauncher);
    }
    updateNativeLauncherState();
    return true;
  }

  function scheduleHeaderLauncherRefresh() {
    clearTimeout(headerRefreshTimer);
    headerRefreshTimer = setTimeout(() => {
      headerRefreshTimer = null;
      ensureHeaderLauncher();
    }, 140);
  }

  function installHeaderLauncher() {
    ensureHeaderLauncher();
    headerObserver?.disconnect();
    headerObserver = new MutationObserver(scheduleHeaderLauncherRefresh);
    headerObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener('hashchange', scheduleHeaderLauncherRefresh);
    window.addEventListener('popstate', scheduleHeaderLauncherRefresh);
    window.addEventListener('resize', scheduleHeaderLauncherRefresh, { passive: true });
  }

  function render() {
    if (!shadow) return;
    const previousScroll = shadow.querySelector('.item-list')?.scrollTop || 0;
    const activeElement = shadow.activeElement;
    const restoreSearchFocus = activeElement?.matches?.('[data-action="search"]') || false;
    const selectionStart = restoreSearchFocus ? activeElement.selectionStart : null;
    const body = apiKey ? appMarkup() : setupMarkup();
    shadow.innerHTML = `
      <style>${styles()}</style>
      <aside id="torn-city-stock-watch-panel" class="panel ${ui.open ? 'open' : ''}" aria-label="Torn City and Foreign Stock Watch">
        <header>
          <div><span class="eyebrow">TORN CITY + ABROAD</span><h1>Stock Watch</h1></div>
          <button class="close-button" data-action="toggle-panel" aria-label="Close">×</button>
        </header>
        <main>${body}</main>
        <footer>City: Torn API · Abroad: community reports · stock is never guaranteed</footer>
      </aside>`;
    bindUiEvents();
    updateNativeLauncherState();
    const itemList = shadow.querySelector('.item-list');
    if (itemList) itemList.scrollTop = previousScroll;
    if (restoreSearchFocus) {
      const search = shadow.querySelector('[data-action="search"]');
      search?.focus();
      if (Number.isInteger(selectionStart)) search?.setSelectionRange(selectionStart, selectionStart);
    }
  }

  function bindUiEvents() {
    shadow.querySelectorAll('[data-action="toggle-panel"]').forEach((button) => {
      button.addEventListener('click', () => {
        ui.open = !ui.open;
        render();
      });
    });

    shadow.querySelector('[data-action="save-key"]')?.addEventListener('click', async () => {
      const input = shadow.querySelector('#tcsw-api-key');
      const candidate = String(input?.value || '').trim();
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(candidate)) {
        status = { kind: 'error', text: 'That does not look like a Torn API key.' };
        const message = shadow.querySelector('.setup-status');
        if (message) {
          message.textContent = status.text;
          message.classList.add('error');
        }
        input?.focus();
        return;
      }
      await connectKey(candidate);
    });

    shadow.querySelector('[data-action="refresh"]')?.addEventListener('click', () => poll({ force: true }));

    shadow.querySelectorAll('[data-action="view"]').forEach((button) => {
      button.addEventListener('click', () => {
        ui.view = button.dataset.view || 'watched';
        render();
      });
    });

    shadow.querySelector('[data-action="search"]')?.addEventListener('input', (event) => {
      ui.query = event.target.value;
      render();
      const input = shadow.querySelector('[data-action="search"]');
      input?.focus();
      input?.setSelectionRange(ui.query.length, ui.query.length);
    });

    shadow.querySelector('[data-action="shop-filter"]')?.addEventListener('change', (event) => {
      ui.shop = event.target.value;
      render();
    });

    shadow.querySelector('[data-action="source-filter"]')?.addEventListener('change', (event) => {
      ui.source = event.target.value;
      ui.shop = 'all';
      render();
    });

    shadow.querySelectorAll('[data-action="toggle-watch"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const key = button.dataset.key;
        if (!key) return;
        state.watched = isWatched(key)
          ? state.watched.filter((entry) => entry !== key)
          : [...state.watched, key];
        await savePreferences();
        render();
      });
    });

    shadow.querySelector('[data-setting="notifications"]')?.addEventListener('change', async (event) => {
      state.settings.notifications = event.target.checked;
      await savePreferences();
    });

    shadow.querySelector('[data-setting="pollSeconds"]')?.addEventListener('change', async (event) => {
      state.settings.pollSeconds = Number(event.target.value);
      await savePreferences();
      schedulePoll(1000);
    });

    shadow.querySelector('[data-action="export-history"]')?.addEventListener('click', exportHistory);

    shadow.querySelector('[data-action="clear-history"]')?.addEventListener('click', async () => {
      if (!window.confirm('Clear all locally learned stock history? Your watchlist and API key will remain.')) return;
      const acquired = await withPollingLock(async () => {
        state.items = {};
        state.notified = {};
        state.lastFetchAt = null;
        state.lastSnapshotKeys = [];
        state.lastForeignAttemptAt = null;
        state.lastForeignFetchAt = null;
        state.lastForeignError = null;
        state.foreignProvider = null;
        state.foreignCountryUpdates = {};
        await saveData();
      });
      if (!acquired) {
        status = { kind: 'idle', text: 'Another Torn tab is already checking; try again shortly' };
        render();
        return;
      }
      status = { kind: 'idle', text: 'History cleared' };
      render();
      await poll({ force: true });
    });

    shadow.querySelector('[data-action="forget-key"]')?.addEventListener('click', async () => {
      if (!window.confirm('Forget the locally stored API key?')) return;
      apiKey = '';
      await gmDelete(API_KEY_STORAGE);
      status = { kind: 'idle', text: 'Waiting for setup' };
      clearTimeout(pollTimer);
      render();
    });
  }

  function exportHistory() {
    const exportData = {
      product: SCRIPT_NAME,
      version: state.version,
      exportedAt: new Date().toISOString(),
      watched: state.watched,
      items: state.items,
      note: 'This export never includes your API key.',
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `torn-stock-watch-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function styles() {
    return `
      :host { all: initial; color-scheme: dark; }
      *, *::before, *::after { box-sizing: border-box; }
      button, input, select { font: inherit; }
      .panel {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; width: min(410px, calc(100vw - 24px));
        height: min(650px, calc(100vh - 36px)); display: none; grid-template-rows: auto 1fr auto;
        overflow: hidden; border: 1px solid rgba(255,255,255,.14); border-radius: 18px;
        color: #e5e7eb; background: #11141a; box-shadow: 0 24px 70px rgba(0,0,0,.58);
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .panel.open { display: grid; animation: rise .16s ease-out; }
      @keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.985); } }
      header { display: flex; align-items: center; justify-content: space-between; padding: 17px 18px 14px; border-bottom: 1px solid #292e38; background: linear-gradient(135deg,#1d1730,#171b24 58%); }
      h1, h2, p { margin: 0; }
      h1 { font-size: 21px; line-height: 1.05; letter-spacing: -.02em; color: #fff; }
      h2 { margin-bottom: 8px; font-size: 17px; color: #fff; }
      .eyebrow { display: block; margin-bottom: 3px; color: #a78bfa; font-size: 9px; font-weight: 800; letter-spacing: .17em; }
      .close-button, .icon-button { border: 0; color: #cbd5e1; background: transparent; cursor: pointer; }
      .close-button { width: 34px; height: 34px; border-radius: 9px; font-size: 26px; line-height: 1; }
      .close-button:hover, .icon-button:hover { color: #fff; background: rgba(255,255,255,.08); }
      main { min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
      footer { padding: 8px 14px; border-top: 1px solid #292e38; color: #7f8795; text-align: center; font-size: 10px; }
      .setup, .settings-view { overflow: auto; padding: 20px; }
      .setup p { color: #aab1be; line-height: 1.55; }
      code { border-radius: 4px; padding: 1px 4px; color: #c4b5fd; background: #28223a; font-family: ui-monospace, monospace; font-size: .92em; }
      .field-label { display: block; margin: 20px 0 6px; color: #cbd5e1; font-weight: 700; }
      .text-input, .search-input, select { border: 1px solid #343a46; border-radius: 9px; color: #eef2f7; background: #191d25; outline: none; }
      .text-input { width: 100%; padding: 11px 12px; }
      .text-input:focus, .search-input:focus, select:focus { border-color: #8b5cf6; box-shadow: 0 0 0 3px rgba(139,92,246,.14); }
      .setup-status { margin-top: 7px; font-size: 11px; }
      .setup-status.error { color: #fda4af; }
      .setup-status.loading { color: #fcd34d; }
      button.primary { border: 1px solid #8b5cf6; color: white; background: #7c3aed; font-weight: 800; cursor: pointer; }
      button.primary:hover { background: #8b5cf6; }
      .wide { width: 100%; margin-top: 10px; border-radius: 9px; padding: 11px; }
      .subtle-link { display: block; margin: 12px 0 18px; color: #a78bfa; text-align: center; text-decoration: none; }
      .subtle-link:hover { text-decoration: underline; }
      .tos { border-top: 1px solid #2b303a; padding-top: 14px; color: #aab1be; }
      .tos summary { cursor: pointer; color: #d5d8df; font-weight: 700; }
      .tos dl { margin: 12px 0 0; }
      .tos dl div { display: grid; grid-template-columns: 100px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid #242933; }
      .tos dt { color: #7f8795; }
      .tos dd { margin: 0; }
      .status-row { display: flex; align-items: center; gap: 7px; min-height: 39px; padding: 7px 12px; border-bottom: 1px solid #292e38; color: #9da5b3; font-size: 11px; }
      .status-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #64748b; }
      .status-dot.ok { background: #34d399; box-shadow: 0 0 0 3px rgba(52,211,153,.1); }
      .status-dot.loading { background: #fbbf24; animation: pulse 1s infinite alternate; }
      .status-dot.warning { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.1); }
      .status-dot.error { background: #fb7185; }
      @keyframes pulse { to { opacity: .4; } }
      .status-text { min-width: 0; overflow: hidden; color: #c4cad4; text-overflow: ellipsis; white-space: nowrap; }
      .data-age { margin-left: auto; white-space: nowrap; }
      .icon-button { width: 27px; height: 27px; border-radius: 7px; font-size: 17px; }
      .icon-button:disabled { opacity: .4; cursor: default; }
      .tabs { display: grid; grid-template-columns: 1fr 1fr 1fr; padding: 8px 10px 0; background: #11141a; }
      .tabs button { border: 0; border-bottom: 2px solid transparent; padding: 8px; color: #8f97a5; background: transparent; cursor: pointer; font-size: 12px; font-weight: 700; }
      .tabs button:hover { color: #d8dce3; }
      .tabs button.active { border-bottom-color: #8b5cf6; color: #c4b5fd; }
      .tabs button span { margin-left: 3px; border-radius: 999px; padding: 1px 5px; background: #282d37; font-size: 9px; }
      .filters { display: grid; grid-template-columns: 1.35fr 1fr; gap: 7px; padding: 10px; }
      .search-input, .filters select { min-width: 0; padding: 8px 9px; font-size: 11px; }
      .filters .search-input { grid-column: 1 / -1; }
      .item-list { min-height: 0; flex: 1; overflow-y: auto; padding: 0 10px 12px; scrollbar-color: #3a414e transparent; }
      .item-card { margin-top: 8px; border: 1px solid #2c323d; border-radius: 11px; padding: 11px; background: #181c24; }
      .item-card.has-stock { border-color: rgba(52,211,153,.28); background: linear-gradient(135deg,rgba(16,185,129,.08),#181c24 45%); }
      .item-card.stale-card { opacity: .72; }
      .item-topline { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
      .item-title-wrap { min-width: 0; }
      .item-title { display: block; overflow: hidden; color: #f5f7fa; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
      .shop-name { display: block; overflow: hidden; margin-top: 1px; color: #7f8795; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
      .watch-button { flex: 0 0 30px; height: 28px; border: 1px solid #333946; border-radius: 8px; color: #727b89; background: #20252e; cursor: pointer; font-size: 18px; line-height: 1; }
      .watch-button:hover, .watch-button.watching { border-color: #7654bd; color: #fbbf24; background: #292139; }
      .stock-line { display: flex; justify-content: space-between; margin-top: 9px; color: #929aa7; font-size: 11px; }
      .stock-line b { color: #e9edf2; font-size: 14px; }
      .stock-bar { height: 4px; margin-top: 6px; overflow: hidden; border-radius: 999px; background: #2d333e; }
      .stock-bar i { display: block; height: 100%; border-radius: inherit; background: #34d399; }
      .empty .stock-bar i { background: #59616e; }
      .community-note { margin-top: 5px; color: #6f7785; font-size: 9px; }
      .item-footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 9px; margin-top: 7px; }
      .prediction { min-width: 0; font-size: 10px; }
      .prediction.available { color: #6ee7b7; }
      .prediction.estimate { color: #c4b5fd; }
      .prediction.overdue { color: #fbbf24; }
      .prediction.learning { color: #7f8795; }
      .prediction.stale { color: #94a3b8; }
      .shop-link { flex: 0 0 auto; color: #a78bfa; font-size: 10px; font-weight: 700; text-decoration: none; }
      .shop-link:hover { color: #c4b5fd; text-decoration: underline; }
      .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 230px; padding: 30px; color: #7f8795; text-align: center; }
      .empty-state b { color: #c6cbd4; font-size: 14px; }
      .empty-state span { margin-top: 5px; font-size: 11px; }
      .limit-note { padding: 14px; color: #7f8795; text-align: center; font-size: 10px; }
      .settings-view h2 { margin-bottom: 4px; }
      .feed-health { display: flex; flex-direction: column; gap: 2px; margin: 12px 0 4px; border: 1px solid rgba(52,211,153,.2); border-radius: 9px; padding: 10px 11px; background: rgba(52,211,153,.06); }
      .feed-health.has-warning { border-color: rgba(245,158,11,.28); background: rgba(245,158,11,.07); }
      .feed-health b { color: #e5e7eb; font-size: 11px; }
      .feed-health span { color: #b9c0cb; font-size: 10px; }
      .feed-health small { overflow-wrap: anywhere; color: #7f8795; font-size: 9px; }
      .feed-health.has-warning small { color: #fbbf24; }
      .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 0; border-bottom: 1px solid #292e38; }
      .setting-row span { display: flex; flex-direction: column; }
      .setting-row b { color: #e5e7eb; font-size: 12px; }
      .setting-row small { max-width: 245px; margin-top: 2px; color: #7f8795; font-size: 10px; }
      .setting-row select { padding: 6px 8px; font-size: 11px; }
      .setting-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: #8b5cf6; }
      .settings-actions { display: grid; gap: 8px; margin-top: 18px; }
      .settings-actions button { border: 1px solid #343a46; border-radius: 8px; padding: 9px; color: #d5dae2; background: #1b2029; cursor: pointer; }
      .settings-actions button:hover { background: #242a35; }
      .settings-actions button.danger { border-color: rgba(251,113,133,.35); color: #fda4af; }
      .privacy-note { display: flex; flex-direction: column; margin-top: 18px; border-radius: 9px; padding: 11px; color: #8e97a5; background: #181c24; font-size: 10px; }
      .privacy-note b { margin-bottom: 2px; color: #c8cdd6; font-size: 11px; }
      @media (max-width: 520px) {
        .panel { right: 0; bottom: 0; width: 100vw; height: min(82vh, 690px); border-right: 0; border-bottom: 0; border-left: 0; border-radius: 18px 18px 0 0; }
        .status-row { gap: 5px; padding-inline: 9px; }
        .data-age { font-size: 9px; }
      }
    `;
  }

  async function boot() {
    const [legacyRaw, preferencesRaw, dataRaw] = await Promise.all([
      gmGet(LEGACY_STORAGE_KEY, null),
      gmGet(PREFERENCES_STORAGE_KEY, null),
      gmGet(DATA_STORAGE_KEY, null),
    ]);
    const legacy = normalizeState(legacyRaw);
    const validPreferences = isValidPreferencesPayload(preferencesRaw);
    const validData = isValidDataPayload(dataRaw);
    state = normalizeState({
      settings: validPreferences ? preferencesRaw.settings : legacy.settings,
      watched: validPreferences ? preferencesRaw.watched : legacy.watched,
      items: validData ? dataRaw.items : legacy.items,
      notified: validData ? dataRaw.notified : legacy.notified,
      lastFetchAt:
        validData && Object.prototype.hasOwnProperty.call(dataRaw, 'lastFetchAt')
          ? dataRaw.lastFetchAt
          : legacy.lastFetchAt,
      lastSnapshotKeys: validData ? dataRaw.lastSnapshotKeys : legacy.lastSnapshotKeys,
      lastForeignAttemptAt:
        validData && Object.prototype.hasOwnProperty.call(dataRaw, 'lastForeignAttemptAt')
          ? dataRaw.lastForeignAttemptAt
          : legacy.lastForeignAttemptAt,
      lastForeignFetchAt:
        validData && Object.prototype.hasOwnProperty.call(dataRaw, 'lastForeignFetchAt')
          ? dataRaw.lastForeignFetchAt
          : legacy.lastForeignFetchAt,
      lastForeignError:
        validData && Object.prototype.hasOwnProperty.call(dataRaw, 'lastForeignError')
          ? dataRaw.lastForeignError
          : legacy.lastForeignError,
      foreignProvider: validData ? dataRaw.foreignProvider : legacy.foreignProvider,
      foreignCountryUpdates:
        validData ? dataRaw.foreignCountryUpdates : legacy.foreignCountryUpdates,
    });
    if (!validPreferences) await savePreferences();
    if (!validData) await saveData();
    if (legacyRaw) await gmDelete(LEGACY_STORAGE_KEY).catch(() => undefined);
    const legacyApiKey = String(await gmGet(LEGACY_API_KEY_STORAGE, '') || '').trim();
    if (legacyApiKey) await gmDelete(LEGACY_API_KEY_STORAGE);
    apiKey = String(await gmGet(API_KEY_STORAGE, '') || '').trim();
    status = apiKey
      ? { kind: 'idle', text: state.lastFetchAt ? 'Ready' : 'Ready for first check' }
      : legacyApiKey
        ? { kind: 'error', text: 'Re-enter a Public Only key so Stock Watch can verify it.' }
        : { kind: 'idle', text: 'Waiting for setup' };

    host = document.createElement('div');
    host.id = 'torn-city-stock-watch-host';
    shadow = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
    registerStorageSync();
    installHeaderLauncher();
    render();

    if (apiKey) {
      await poll();
      schedulePoll();
    }
  }

  if (typeof globalThis !== 'undefined' && globalThis.__TCSW_TEST_MODE__) {
    globalThis.__TCSW_TEST_EXPORTS__ = {
      ceilToQuarterHour,
      fitTickAwareRatio,
      predictionTickLoss,
      learnedRatio,
      predictionConfidence,
      predictCycle,
      looksLikeRestock,
      foreignItemKey,
      foreignItemCount,
      shopUrl,
      formatTct,
      predictionText,
      isPublicOnlyKeyInfo,
      decodePublicJsonResponse,
      publicJsonRequest,
      ensureHeaderLauncher,
      headerStatusLists,
      updateNativeLauncherState,
      processStockResponse,
      parseForeignStockResponse,
      mergeForeignCandidates,
      processForeignStockResponse,
      normalizeState,
      isValidPreferencesPayload,
      isValidDataPayload,
      getState: () => state,
      setState: (next) => {
        state = normalizeState(next);
      },
    };
    return;
  }

  boot().catch((error) => {
    console.error(`[${SCRIPT_NAME}] Failed to start`, error);
  });
})();
