/* ==========================================
   WEATHER MODULE - Weather forecast for routes
   Uses Open-Meteo API (100% FREE - no API key needed!)
   Includes: Current + Past 3 days + 5 day forecast

   NOTE: this is a deliberate copy of steepmap/weatherModule.js, kept here
   so this standalone app has no dependency on the main SteepMap frontend.
   Algorithm fixes must be applied to BOTH copies manually — they are not
   kept in sync automatically. Last synced 2026-11-11 (humidity/modifier
   dry-only fix, hoursSinceRain===0 hard WET lock, temperature-scaled
   drying power beyond the 2h hard lock, every hour now scored + global
   allHourScores lookup as the single source of truth for past/current hours,
   shared _formatHoursSinceRainMessage so the big-dot message travels with
   whichever hour's score is actually driving the dot, rainDurationHours factor
   lets light/brief rain (sev 1, <12h actual rain) read PATCHY not WET once past
   a shorter 1h no-exceptions window instead of the flat 2h lock for all rain;
   light/brief rain's modifiers are dry-only too, so calm+humid windMod can't
   re-inflate the PATCHY floor back to WET in both calculateRoadCondition and
   scoreHourCondition's 2-6h bands; day-dot now weighted by box/skating-window
   overlap fraction instead of flat per-box counting, with a green bar that
   scales down for shorter skating windows — single unified calc, uiModule.js's
   separate aggregateDot deleted entirely).
   ========================================== */

function initWeatherModule() {
    const module = {
        baseURL: 'https://api.open-meteo.com/v1/forecast'
    };

    /**
     * Parse a timestamp string as local time, cross-browser safe.
     * Open-Meteo returns times like "2026-03-29T16:00" — no timezone suffix,
     * meaning local time for the spot's timezone (via timezone:auto).
     * Safari parses T-separated ISO strings without suffix as UTC — wrong.
     * Replacing T with a space forces all browsers to treat it as local time.
     */
    const parseLocalTime = (raw) => {
        if (!raw) return new Date(NaN);
        if (raw.includes('Z') || raw.includes('+')) return new Date(raw);
        const [datePart, timePart = '00:00'] = raw.split('T');
        const [yr, mo, dy] = datePart.split('-').map(Number);
        const [hr, mn] = timePart.split(':').map(Number);
        return new Date(yr, mo - 1, dy, hr, mn, 0, 0);
    };

    /**
     * Get comprehensive weather data (current + past + forecast)
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @returns {Promise} Weather data object with current, past, forecast, and roadCondition
     */
    module.getForecast = async function(lat, lng) {
        console.log(`🌤️ getForecast called with lat=${lat}, lng=${lng}`);
        
        try {
            // Build URL with all parameters we need
            const params = new URLSearchParams({
                latitude: lat,
                longitude: lng,
                // Current weather
                current: 'temperature_2m,precipitation,weathercode,windspeed_10m,winddirection_10m,relative_humidity_2m',
                // Hourly data for precise road condition analysis
                hourly: 'precipitation,relative_humidity_2m,temperature_2m,dewpoint_2m,windspeed_10m,weather_code',
                // Daily aggregates (for forecast display)
                daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weathercode,windspeed_10m_max,winddirection_10m_dominant,relative_humidity_2m_mean,sunrise,sunset',
                // Include past 3 days + 14 days forecast
                past_days: 3,
                forecast_days: 14,
                timezone: 'auto'
            });

            const url = `${this.baseURL}?${params.toString()}`;
            console.log('🌤️ Fetching weather from Open-Meteo:', url);
            
            const response = await fetch(url);
            
            if (!response.ok) {
                console.error(`❌ Weather API returned status ${response.status}`);
                throw new Error(`Weather API error: ${response.status}`);
            }
            
            const data = await response.json();
            console.log('🌤️ Raw API response:', data);
            
            const processedData = this.processWeatherData(data);
            processedData._lat = lat;
            processedData._lng = lng;
            console.log('🌤️ Processed weather data:', processedData);

            return processedData;
        } catch (error) {
            console.error('❌ Failed to fetch weather:', error);
            return null;
        }
    };

    /**
     * Process Open-Meteo data into our format
     */
    module.processWeatherData = function(data) {
        if (!data || !data.daily) return null;

        const current = this.processCurrentWeather(data);

        // Calculate road condition first so forecast can use it as carry seed
        const roadCondition = this.calculateRoadCondition(data, current);

        const result = {
            current: current,
            past: this.processPastDays(data),
            forecast: this.processForecast(data, roadCondition),
            upcoming: this.getUpcomingHourlyForecast(data),
            roadCondition: roadCondition
        };

        console.log('🌤️ Processed weather data:', result);
        return result;
    };

    /**
     * Process current weather
     */
    module.processCurrentWeather = function(data) {
        if (!data.current) return null;

        return {
            temp: Math.round(data.current.temperature_2m),
            precipitation: data.current.precipitation || 0,
            humidity: Math.round(data.current.relative_humidity_2m) || null,
            weatherCode: data.current.weathercode,
            weatherEmoji: this.getWeatherEmoji(data.current.weathercode),
            weatherText: this.getWeatherText(data.current.weathercode),
            windSpeed: Math.round(data.current.windspeed_10m),
            windDirection: data.current.winddirection_10m,
            windArrow: this.getWindArrow(data.current.winddirection_10m),
            isDry: data.current.precipitation < 0.1
        };
    };

    /**
     * Process past 3 days (for road condition analysis)
     */
    module.processPastDays = function(data) {
        if (!data.daily) return [];

        const past = [];
        const today = new Date();
        
        // Get the first 3 days (which are past days due to past_days=3)
        for (let i = 0; i < 3 && i < data.daily.time.length; i++) {
            const date = new Date(data.daily.time[i]);
            
            // Only include if it's actually in the past
            if (date < today) {
                past.push({
                    date: date,
                    dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
                    precipitation: data.daily.precipitation_sum[i] || 0,
                    precipProb: 0, // Past days don't have probability
                    humidity: Math.round(data.daily.relative_humidity_2m_mean[i]) || 0,
                    weatherCode: data.daily.weathercode[i],
                    weatherEmoji: this.getWeatherEmoji(data.daily.weathercode[i]),
                    temp: Math.round(data.daily.temperature_2m_max[i]), // Use max temp for consistency
                    tempMax: Math.round(data.daily.temperature_2m_max[i]),
                    tempMin: Math.round(data.daily.temperature_2m_min[i])
                });
            }
        }

        return past.reverse(); // Most recent first
    };

    /**
     * Process forecast (next 5 days)
     */
    /**
     * scoreHourCondition — core decision logic for per-hour road condition scoring.
     * Given the state at a specific hour, returns {status, color, emoji}.
     *
     * Modifier design (science-backed, see algo reference doc):
     *   - Humidity is the primary drying driver.
     *   - Wind is co-primary: it replaces the saturated air layer above the surface.
     *   - Temp–dewpoint gap (depression) is the best single measure of drying capacity.
     *   - Air temperature has a smaller independent effect (cold slows drying).
     *   - All three modifiers apply consistently across all bands (except 0h and 1–2h locks).
     *   - Modifier stacking is capped: no combination can override active/recent rain floors.
     *
     * @param {number|null} hoursSinceRain  — hours since last rain (null = no rain in 48h+)
     * @param {number}      rainSeverity    — 0–3: max of peak-hour and 12h-sustained scores
     * @param {number}      humidity        — relative humidity % at this hour
     * @param {number|null} dewpoint        — dew point °C at this hour (null = unknown)
     * @param {number|null} wind            — wind speed km/h at this hour (null = unknown)
     * @param {number|null} temperature     — air temperature °C at this hour (null = unknown)
     * @param {number}      rainDurationHours — consecutive hours the most recent rain event
     *   actually lasted (distinct from severity/amount); defaults to a large number (treated
     *   as "not brief") if omitted, so existing callers without this data are unaffected.
     */

    /**
     * Shared "how long since rain" message text, used by both calculateRoadCondition
     * (today's live status) and processForecast (every hour's unified score) — one
     * place generating this text instead of two independently-worded copies, so the
     * big dot's subtext can never contradict the hour it's actually describing.
     */
    module._formatHoursSinceRainMessage = function(h) {
        if (h === null) return 'No rain 3+ days';
        if (h === 0) return 'Raining now';
        if (h < 24) return `Rain ${h}h ago`;
        return `Rain ${Math.floor(h / 24)}d ago`;
    };
    module.scoreHourCondition = function(hoursSinceRain, rainSeverity, humidity, dewpoint, wind, temperature, rainDurationHours) {
        const BANDS = ['DRY', 'PATCHY', 'WET'];
        const applyMods = (baseIdx, ...mods) => {
            const idx = Math.max(0, Math.min(2, baseIdx + mods.reduce((a,b) => a+b, 0)));
            return { status: BANDS[idx], color: ['green','yellow','red'][idx], emoji: ['🟢','🟡','🔴'][idx] };
        };

        // --- Temp–dewpoint depression modifier (replaces raw dewpoint mod) ---
        // The gap between air temp and dewpoint is the most direct measure of drying capacity.
        // A large gap = air can absorb much more moisture = fast drying.
        // A small gap = air nearly saturated = evaporation nearly stops.
        let dewDeprMod = 0;
        if (dewpoint !== null && temperature !== null) {
            const gap = temperature - dewpoint;
            if      (gap < 3)  dewDeprMod = +1;  // near-saturated air, surface won't dry
            else if (gap < 6)  dewDeprMod =  0;  // marginal drying capacity
            else if (gap < 12) dewDeprMod = -1;  // good drying capacity
            else               dewDeprMod = -2;  // excellent drying capacity (hot dry air)
        } else if (dewpoint !== null) {
            // No temperature: fall back to raw dewpoint as a proxy
            if      (dewpoint > 10) dewDeprMod = +1;
            else if (dewpoint < 5)  dewDeprMod = -1;
        }

        // --- Wind modifier (tiered, promoted to co-primary driver) ---
        // Wind physically removes the saturated air layer sitting on the road surface,
        // which is the rate-limiting step in surface drying regardless of ambient humidity.
        let windMod = 0;
        if (wind !== null) {
            if      (wind > 30) windMod = -2;  // strong: fast drying
            else if (wind > 15) windMod = -1;  // moderate: good drying
            else if (wind < 5)  windMod = +1;  // still: saturated layer persists
            // 5–15 km/h: neutral (light breeze, modest effect)
        }

        // --- Temperature modifier (light, independent effect) ---
        // Warm surfaces evaporate faster; cold surfaces hold moisture much longer.
        // Smaller weight than wind/dewDep since temperature's main effect is already
        // captured via its influence on the dewpoint depression above.
        let tempMod = 0;
        if (temperature !== null) {
            if      (temperature < 5)  tempMod = +1;  // cold: slow drying
            else if (temperature > 15) tempMod = -1;  // warm: faster drying
            // 5–15°C: neutral
        }

        // --- Cap total modifier to avoid nonsensical results ---
        // In drying bands (no active rain), mods can shift ±2 at most.
        // This prevents e.g. very hot + windy + dry air from making a post-heavy-rain
        // hour look green when the road is physically still soaked.
        const totalMod = Math.max(-2, Math.min(2, dewDeprMod + windMod + tempMod));

        // --- Temperature-scaled drying power (bands beyond the 1-2h hard lock only) ---
        // Same reasoning as calculateRoadCondition: these ambient modifiers' drying
        // direction is only as effective as the temperature allows — cold air has little
        // real drying power even when windy/dry, warm air dries genuinely fast. Only ever
        // weakens (cold) or strengthens (warm) an already-negative total; never flips a
        // dampening total into a drying one.
        const scaledTotalMod = totalMod >= 0 || temperature === null ? totalMod
            : temperature < 5  ? 0
            : temperature > 15 ? totalMod - 1
            : totalMod;

        // 0h: actively raining — always WET, no exceptions
        if (hoursSinceRain === 0) {
            return { status: 'WET', color: 'red', emoji: '🔴' };
        }

        // 1–2h: hard lock — severity drives result, no modifier softening.
        // Road is physically wet regardless of conditions — except light, brief rain
        // (severity 1, under ~12h of actual rain), which doesn't leave the same soaking
        // and reads as PATCHY rather than WET.
        if (hoursSinceRain < 2) {
            const durationHrs = rainDurationHours === undefined ? Infinity : rainDurationHours;
            const lightBriefRain = rainSeverity === 1 && durationHrs < 12;
            const base = lightBriefRain ? 1 : (rainSeverity >= 1 ? 2 : 1);
            return { status: BANDS[base], color: ['green','yellow','red'][base], emoji: ['🟢','🟡','🔴'][base] };
        }

        // No recent rain: check for persistent damp (fog, condensation, high-humidity air mass)
        // No rain in the window → modifiers may only dry things out, never manufacture wetness;
        // and humidity alone can never reach WET without actual rain involved.
        if (hoursSinceRain === null) {
            const base = humidity > 78 ? 1 : 0;
            return applyMods(base, Math.min(0, scaledTotalMod));
        }

        // 2–6h: humidity-gated with full modifiers, but floor prevents mods overriding wet road
        if (hoursSinceRain < 6) {
            const durationHrs = rainDurationHours === undefined ? Infinity : rainDurationHours;
            const lightBriefRain = rainSeverity === 1 && durationHrs < 12;

            let base;
            if      (rainSeverity >= 3)                        base = 2; // very heavy: WET floor
            else if (rainSeverity >= 2 && humidity > 65)       base = 2; // moderate + damp: WET
            else if (rainSeverity >= 2)                        base = 1; // moderate + drier air: PATCHY floor
            else if (rainSeverity >= 1 && humidity > 65)       base = 1; // light + damp: PATCHY
            else if (rainSeverity >= 1 && hoursSinceRain < 4)  base = 1; // light + dry + recent: PATCHY
            else                                                base = 0; // light + dry + 4–6h: DRY possible
            // Floor: severity ≥2 OR persistently high humidity → mods cannot push below PATCHY
            const minIdx = (rainSeverity >= 2 || humidity > 78) ? 1 : 0;
            // Light, brief rain's ambient modifiers may only dry things out further,
            // never push it back up toward WET — same rule as the no-rain-relevant
            // bands (found 2026-11-12: calm+humid windMod was silently re-inflating
            // PATCHY back to WET here for a short, light rain event).
            const effMod = lightBriefRain ? Math.min(0, scaledTotalMod) : scaledTotalMod;
            const idx = Math.max(minIdx, Math.min(2, base + effMod));
            return { status: BANDS[idx], color: ['green','yellow','red'][idx], emoji: ['🟢','🟡','🔴'][idx] };
        }

        // 6–12h
        if (hoursSinceRain < 12) {
            // Escape hatch: 8+ hours since rain, genuinely low humidity AND good dew depression
            // → treat like 12–24h band to avoid over-pessimism after clear post-storm conditions.
            if (hoursSinceRain >= 8 && humidity < 60 && (dewpoint === null || dewpoint < 5)) {
                let base;
                if      (rainSeverity >= 3 && humidity > 78) base = 2;
                else if (rainSeverity >= 2 || humidity > 85) base = 1;
                else if (rainSeverity >= 1 || humidity > 78) base = 1;
                else                                          base = 0;
                return applyMods(base, scaledTotalMod);
            }
            let base;
            if      (rainSeverity >= 2 || humidity > 85) base = 2;
            else if (rainSeverity >= 1 || humidity > 78) base = 1;
            else                                          base = 0;
            return applyMods(base, scaledTotalMod);
        }

        // 12–24h
        if (hoursSinceRain < 24) {
            let base;
            if      (rainSeverity >= 3 && humidity > 78) base = 2;
            else if (rainSeverity >= 2 || humidity > 85) base = 1;
            else if (rainSeverity >= 1 || humidity > 78) base = 1;
            else                                          base = 0;
            return applyMods(base, scaledTotalMod);
        }

        // 24–48h
        if (hoursSinceRain < 48) {
            let base;
            if      (rainSeverity >= 3 && humidity > 78) base = 2;
            else if (rainSeverity >= 2 || humidity > 78) base = 1;
            else                                          base = 0;
            return applyMods(base, scaledTotalMod);
        }

        // 48h+: DRY unless persistent damp conditions. Same no-rain-relevant rule as the
        // null band above — modifiers dry-only, humidity alone capped below WET.
        const base = humidity > 78 ? 1 : 0;
        return applyMods(base, Math.min(0, scaledTotalMod));
    };

    module.processForecast = function(data, roadCondition) {
        if (!data.daily || !data.hourly) return [];

        const now = new Date();
        const hourly = data.hourly;
        const daily  = data.daily;

        // --- Build full hourly array (past + future) with parsed timestamps ---
        const allHours = [];
        for (let i = 0; i < hourly.time.length; i++) {
            const raw = hourly.time[i];
            const t = parseLocalTime(raw);

            allHours.push({
                t,
                precip:   hourly.precipitation[i]        || 0,
                humidity: hourly.relative_humidity_2m[i] || 0,
                dewpoint: hourly.dewpoint_2m ? (hourly.dewpoint_2m[i] ?? null) : null,
                wind:     hourly.windspeed_10m ? (hourly.windspeed_10m[i] ?? null) : null,
                temp:     hourly.temperature_2m ? (hourly.temperature_2m[i] ?? null) : null,
                score:    null  // filled below
            });
        }

        // --- Walk all hours chronologically, computing per-hour road condition ---
        // Scores EVERY hour (past 3d through forecast horizon), not just future ones —
        // past hours need the same real 12h-window rainSeverity as future ones so that
        // the big-dot "current slot" lookup and any past-hour strip rendering can read a
        // properly-computed score instead of re-deriving one locally (that re-derivation
        // was the source of the hour-strip/big-dot disagreement bug, 2026-11-11).
        // Track: hoursSinceRain (counting forward), rolling 12h precip for severity
        let lastRainIdx = null;

        for (let i = 0; i < allHours.length; i++) {
            const h = allHours[i];

            // Update lastRainIdx if this hour has rain
            if (h.precip > 0.1) lastRainIdx = i;

            // hoursSinceRain: how many hours ago was the last rain?
            let hoursSinceRain = null;
            if (lastRainIdx !== null) {
                hoursSinceRain = Math.round((h.t - allHours[lastRainIdx].t) / 3600000);
            }

            // Rain severity: peak mm/h and 12h total in the 12h window ending at this hour
            const cutoff12h = new Date(h.t.getTime() - 12 * 3600000);
            let maxPrecip = 0, total12h = 0;
            for (let j = i - 1; j >= 0; j--) {
                if (allHours[j].t < cutoff12h) break;
                if (allHours[j].precip > maxPrecip) maxPrecip = allHours[j].precip;
                total12h += allHours[j].precip;
            }
            // Include this hour's own precip in the 12h window and severity
            const thisPrecip = h.precip;
            const effectiveMaxPrecip = Math.max(maxPrecip, thisPrecip);
            const effectiveTotal12h  = total12h + thisPrecip;
            const peakScore      = effectiveMaxPrecip < 0.3 ? 0 : effectiveMaxPrecip < 3 ? 1 : effectiveMaxPrecip < 6 ? 2 : 3;
            const sustainedScore = effectiveTotal12h  < 2   ? 0 : effectiveTotal12h  < 8 ? 1 : effectiveTotal12h  < 20 ? 2 : 3;
            const rainSeverity   = Math.max(peakScore, sustainedScore);

            // If this hour itself has rain, hoursSinceRain = 0
            const effectiveHoursSinceRain = thisPrecip > 0.1 ? 0 : hoursSinceRain;

            // How many consecutive hours did the most recent rain event actually last —
            // distinct from rainSeverity (intensity/total amount).
            let rainDurationHours = 0;
            if (lastRainIdx !== null) {
                for (let k = lastRainIdx; k >= 0; k--) {
                    if (allHours[k].precip > 0.1) rainDurationHours++;
                    else break;
                }
            }

            h.score = this.scoreHourCondition(effectiveHoursSinceRain, rainSeverity, h.humidity, h.dewpoint, h.wind, h.temp, rainDurationHours);
            h.hoursSinceRain = effectiveHoursSinceRain;
            h.rainSeverity   = rainSeverity;

            // Grace period: score cannot jump more than one step down per 2-hour block.
            // Looks back at the previous 2 scored hours (one strip block) and takes the worse.
            // WET -> next can be PATCHY at best (not DRY)
            // PATCHY -> next can be DRY only if humidity is genuinely low (<65%)
            const prevTwo = allHours.slice(0, i).filter(ph => ph.score !== null).slice(-2);
            if (prevTwo.length > 0) {
                // Worst status among the last 1–2 scored hours
                const prevWorst = prevTwo.some(ph => ph.score.status === 'WET') ? 'WET'
                    : prevTwo.some(ph => ph.score.status === 'PATCHY') ? 'PATCHY'
                    : 'DRY';
                const cur = h.score.status;
                if (prevWorst === 'WET' && cur === 'DRY') {
                    h.score = { status: 'PATCHY', color: 'yellow', emoji: '🟡' };
                } else if (prevWorst === 'PATCHY' && cur === 'DRY' && h.humidity >= 65) {
                    h.score = { status: 'PATCHY', color: 'yellow', emoji: '🟡' };
                }
            }
        }

        // --- Helper: skating window for a daily index ---
        const getWindow = (di) => {
            const sr = new Date(daily.sunrise[di]);
            const ss = new Date(daily.sunset[di]);
            if (!sr || !ss || isNaN(sr) || isNaN(ss)) return null;
            const dlMs = ss - sr;
            if (dlMs <= 0) return null;
            return {
                start: new Date(sr.getTime() + dlMs * 0.30),
                end:   new Date(ss.getTime() + dlMs * 0.10)
            };
        };

        // Lookup from timestamp (ms) to allHours index — used to find an hour's paired
        // partner (the next hour) when building 2-hour day-dot "boxes" below.
        const allHoursByTime = new Map(allHours.map((h, idx) => [h.t.getTime(), idx]));

        // --- Build forecast day objects ---
        const today = new Date(); today.setHours(0, 0, 0, 0);
        let startIndex = 3;
        for (let i = 0; i < daily.time.length; i++) {
            const d = new Date(daily.time[i]); d.setHours(0,0,0,0);
            if (d >= today) { startIndex = i; break; }
        }

        const forecasts = [];
        for (let i = startIndex; i < startIndex + 14 && i < daily.time.length; i++) {
            const date = new Date(daily.time[i]);
            const dayStart = new Date(date); dayStart.setHours(0,0,0,0);
            const dayEnd   = new Date(dayStart.getTime() + 24 * 3600000);
            const win      = getWindow(i);

            // All scored future hours for this day
            const dayHours = allHours.filter(h => h.t > now && h.t >= dayStart && h.t < dayEnd && h.score !== null);

            // Day dot: based on 2-hour paired "boxes" that overlap the skating window,
            // weighted by HOW MUCH of each box actually overlaps it — a box clipping
            // just a few minutes of the window counts for almost nothing, instead of
            // the same full weight as a box entirely inside it (found 2026-11-13: an
            // 08:00 box barely clipping a 9:55 window start was otherwise "almost
            // irrelevant" in reality but counted as a full box). Each box pairs an even
            // hour with its next (odd) hour and takes the WORSE of the two, matching
            // what the hour strip actually displays — unified here as the single
            // calculation both apps read from, replacing two separately-coded (and
            // once-disagreeing) implementations.
            //
            // The green bar also scales with how much skating-window data there is:
            // short windows (common outside summer) get a more forgiving bar than long
            // ones, so a single marginal hour doesn't swing an otherwise-mostly-green
            // short day to PATCHY the way a flat 80% requirement would.
            // Rules (totalWeight = sum of box overlap-weights, ~window-hours/2):
            //   RED:   greenWeight<REDFLOOR && redWeight>=REDFLOOR
            //          OR redWeight > greenWeight+0.5 && redWeight >= totalWeight*0.6
            //   GREEN: redWeight<REDFLOOR && greenWeight >= totalWeight*greenPct
            //   YELLOW: everything else
            let forecastCondition = { status: 'DRY', color: 'green', emoji: '🟢' };

            const REDFLOOR = 0.15; // a red sliver under ~18min of a 2h box doesn't count as "red present"
            const boxWeights = [];
            if (win) {
                for (const h of dayHours) {
                    if (h.t.getHours() % 2 !== 0) continue; // one box per even hour
                    const boxStart = h.t.getTime();
                    const boxEnd   = boxStart + 2 * 3600000;
                    const overlapMs = Math.min(boxEnd, win.end.getTime()) - Math.max(boxStart, win.start.getTime());
                    if (overlapMs <= 0) continue; // box doesn't overlap the skating window at all
                    const weight = overlapMs / (2 * 3600000);
                    const partnerIdx = allHoursByTime.get(h.t.getTime() + 3600000);
                    const partner = partnerIdx !== undefined ? allHours[partnerIdx] : null;
                    const statuses = [h.score.status];
                    if (partner && partner.score) statuses.push(partner.score.status);
                    const worst = statuses.includes('WET') ? 'WET' : statuses.includes('PATCHY') ? 'PATCHY' : 'DRY';
                    boxWeights.push({ status: worst, weight });
                }
            }

            if (boxWeights.length > 0) {
                const totalWeight = boxWeights.reduce((a, b) => a + b.weight, 0);
                const redWeight   = boxWeights.filter(b => b.status === 'WET').reduce((a, b) => a + b.weight, 0);
                const greenWeight = boxWeights.filter(b => b.status === 'DRY').reduce((a, b) => a + b.weight, 0);
                const greenPct    = totalWeight >= 6 ? 0.8 : totalWeight >= 3 ? 0.7 : 0.6;
                const redThresh   = totalWeight * 0.6;
                const greenThresh = totalWeight * greenPct;

                const isRed = (greenWeight < REDFLOOR && redWeight >= REDFLOOR) ||
                              (redWeight > greenWeight + 0.5 && redWeight >= redThresh);
                const isGreen = redWeight < REDFLOOR && greenWeight >= greenThresh;

                if (isRed)        forecastCondition = { status: 'WET',    color: 'red',    emoji: '🔴' };
                else if (isGreen) forecastCondition = { status: 'DRY',    color: 'green',  emoji: '🟢' };
                else              forecastCondition = { status: 'PATCHY', color: 'yellow', emoji: '🟡' };

            } else if (dayHours.length > 0) {
                // No skating window data — fall back to all day hours
                const anyWet    = dayHours.some(h => h.score.status === 'WET');
                const anyPatchy = dayHours.some(h => h.score.status === 'PATCHY');
                if (anyWet)         forecastCondition = { status: 'WET',    color: 'red',    emoji: '🔴' };
                else if (anyPatchy) forecastCondition = { status: 'PATCHY', color: 'yellow', emoji: '🟡' };
            } else {
                // No future hours remain (e.g. checked at 23:51) — use most recent scored hour of today
                const todayScored = allHours.filter(h => h.t >= dayStart && h.t < dayEnd && h.score !== null);
                if (todayScored.length > 0) {
                    const lastHour = todayScored[todayScored.length - 1];
                    forecastCondition = lastHour.score;
                }
            }

            // Build hourScores map: local "YYYY-MM-DDTHH" → score, for uiModule strip
            const hourScores = {};
            for (const h of dayHours) {
                const localKey = h.t.getFullYear() + '-' +
                    String(h.t.getMonth()+1).padStart(2,'0') + '-' +
                    String(h.t.getDate()).padStart(2,'0') + 'T' +
                    String(h.t.getHours()).padStart(2,'0');
                // Always force WET for hours with active precipitation
                hourScores[localKey] = h.precip > 0.1
                    ? { status: 'WET', color: 'red', emoji: '🔴' }
                    : h.score;
            }

            forecasts.push({
                date:            date,
                dayName:         date.toLocaleDateString('en-US', { weekday: 'short' }),
                temp:            Math.round((daily.temperature_2m_max[i] + daily.temperature_2m_min[i]) / 2),
                tempMax:         Math.round(daily.temperature_2m_max[i]),
                tempMin:         Math.round(daily.temperature_2m_min[i]),
                precipitation:   daily.precipitation_sum[i] || 0,
                precipProb:      daily.precipitation_probability_max[i] || 0,
                humidity:        Math.round(daily.relative_humidity_2m_mean[i]) || 0,
                weatherCode:     daily.weathercode[i],
                weatherEmoji:    this.getWeatherEmoji(daily.weathercode[i]),
                windSpeed:       Math.round(daily.windspeed_10m_max[i]),
                windDirection:   daily.winddirection_10m_dominant[i],
                windArrow:       this.getWindArrow(daily.winddirection_10m_dominant[i]),
                forecastCondition,
                skatingStart:    win ? win.start : null,
                skatingEnd:      win ? win.end   : null,
                hourScores       // keyed by "YYYY-MM-DDTHH" UTC ISO prefix
            });
        }

        // --- Global hour-score lookup, covering every hour in allHours (past 3d +  ---
        // --- forecast horizon) — the single source of truth every consumer (hour   ---
        // --- strip, big-dot current-slot, past-day detail views) should read from, ---
        // --- instead of re-deriving a score locally from scratch.
        const allHourScores = {};
        for (const h of allHours) {
            if (h.score === null) continue;
            const localKey = h.t.getFullYear() + '-' +
                String(h.t.getMonth()+1).padStart(2,'0') + '-' +
                String(h.t.getDate()).padStart(2,'0') + 'T' +
                String(h.t.getHours()).padStart(2,'0');
            const base = h.precip > 0.1
                ? { status: 'WET', color: 'red', emoji: '🔴' }
                : h.score;
            // hoursSinceRain/message travel with the score so any consumer showing this
            // hour's dot can show matching text, instead of a separately-tracked message
            // that can contradict the dot (the big-dot/message mismatch, 2026-11-11).
            allHourScores[localKey] = {
                ...base,
                hoursSinceRain: h.hoursSinceRain,
                message: this._formatHoursSinceRainMessage(h.hoursSinceRain)
            };
        }
        forecasts.allHourScores = allHourScores;

        return forecasts;
    };

    /**
     * Calculate road condition based on current + past precipitation
     * Critical for longboarding safety!
     */
    /**
     * Calculate road condition based on HOURLY precipitation + solar-adjusted humidity
     * Uses actual skating hours (sunrise+30% to sunset+10%) to calculate min humidity
     * Critical for longboarding safety!
     */
    module.calculateRoadCondition = function(data, currentWeather) {
        console.log('🚦 Calculating road condition v2 (windows + dew point + sustained rain)...');

        if (!data || !data.hourly || !data.daily) {
            return { status: 'UNKNOWN', color: 'gray', emoji: '⚪', message: 'No data' };
        }

        // PRIORITY 1: Raining right now
        if (currentWeather && currentWeather.precipitation > 0.1) {
            return { status: 'WET', color: 'red', emoji: '🔴', message: 'Raining now',
                safe: false, accumulatedRain: null, avgHumidity: currentWeather.humidity || null,
                hoursSinceRain: 0, minDaytimeHumidity: null, rawData: data };
        }

        const now = new Date();
        const hourly = data.hourly;
        const daily  = data.daily;

        // --- Build past hourly array (newest first) ---
        const pastHours = [];
        for (let i = hourly.time.length - 1; i >= 0; i--) {
            const time = new Date(hourly.time[i]);
            if (time > now) continue;
            pastHours.push({
                time,
                precip:   hourly.precipitation[i]        || 0,
                humidity: hourly.relative_humidity_2m[i] || 0,
                dewpoint: hourly.dewpoint_2m ? (hourly.dewpoint_2m[i] ?? null) : null,
                wind: hourly.windspeed_10m ? (hourly.windspeed_10m[i] ?? null) : null,
                temp:     hourly.temperature_2m[i]       || null
            });
        }

        // --- Daily lag cross-check ---
        // Purpose: detect when hourly data lags behind actual rain by ~1h.
        // We only compare past hourly sum against the portion of the daily total
        // that could plausibly have fallen already — i.e. we derive an "elapsed
        // daily estimate" from the hourly data itself rather than trusting the
        // full-day precipitation_sum (which includes future forecast hours).
        // This prevents a forecast shower at 6pm triggering a false WET at midnight.
        const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
        let todayHourlySum = 0;
        for (const h of pastHours) { if (h.time >= todayStart) todayHourlySum += h.precip; }
        // Build elapsed hourly total from the raw hourly array (past hours only)
        // and compare against the same window — so lag check is purely historical
        let todayHourlyFromRaw = 0;
        const nowHour = new Date(now); nowHour.setMinutes(0,0,0);
        for (let i = 0; i < hourly.time.length; i++) {
            const t = new Date(hourly.time[i]);
            if (t < todayStart || t > nowHour) continue;
            todayHourlyFromRaw += hourly.precipitation[i] || 0;
        }
        // Lag is only real if raw sum and pastHours sum diverge — means API hasn't
        // caught up. Never use full daily_sum as it includes future forecast hours.
        const unaccountedRain = Math.max(0, todayHourlyFromRaw - todayHourlySum);
        const hourlyLagged = unaccountedRain > 0.2;

        // --- Find last rain hour, and how long that rain event actually lasted ---
        // rainDurationHours is distinct from rainSeverity (intensity/total amount) —
        // a brief burst and a long soaking can share the same severity but dry very
        // differently. pastHours is newest-first, so scanning forward from the last
        // rain hour counts consecutive rain hours further back in time.
        let hoursSinceRain = null, lastRainTime = null, rainDurationHours = 0;
        for (let i = 0; i < pastHours.length; i++) {
            if (pastHours[i].precip > 0.1) {
                lastRainTime = pastHours[i].time;
                hoursSinceRain = Math.floor((now - lastRainTime) / 3600000);
                for (let j = i; j < pastHours.length; j++) {
                    if (pastHours[j].precip > 0.1) rainDurationHours++;
                    else break;
                }
                break;
            }
        }
        if (hourlyLagged && (hoursSinceRain === null || hoursSinceRain > 1)) {
            hoursSinceRain = 0;
            lastRainTime = now;
        }

        // PRIORITY 1b: hourly data shows rain in the current hour, even though the
        // instantaneous "current weather" reading above missed it (nowcast vs. observed
        // data can disagree). Same hard WET lock as PRIORITY 1 — the road is still
        // physically wet regardless of how light the hourly amount looks, so severity
        // thresholds must not be allowed to soften this down to PATCHY.
        if (hoursSinceRain === 0) {
            return { status: 'WET', color: 'red', emoji: '🔴',
                message: hourlyLagged ? `Rain today (${unaccountedRain.toFixed(1)}mm, data updating)` : 'Raining now',
                safe: false, accumulatedRain: null, avgHumidity: currentWeather ? currentWeather.humidity : null,
                hoursSinceRain: 0, minDaytimeHumidity: null, rawData: data };
        }

        // --- Rain severity score (0-3): max of peak-hour score and sustained-12h score ---
        // Both components use the same 12h window — a peak from a light shower far outside
        // this window (but still inside 48h) should not keep propping up rainSeverity long
        // after that rain is no longer relevant to current road wetness.
        const cutoff12h = new Date(now.getTime() - 12 * 3600000);
        const cutoff48h = new Date(now.getTime() - 48 * 3600000);
        let maxRainAmount = 0, totalRain12h = 0, accumulatedRain48h = 0, accumulatedRainEvent = 0;
        for (const h of pastHours) {
            if (h.time < cutoff48h) break;
            accumulatedRain48h += h.precip;
            if (h.time >= cutoff12h) {
                if (h.precip > maxRainAmount) maxRainAmount = h.precip;
                totalRain12h += h.precip;
            }
            if (lastRainTime && h.time >= lastRainTime) accumulatedRainEvent += h.precip;
        }
        const peakScore     = maxRainAmount < 1 ? 0 : maxRainAmount < 3 ? 1 : maxRainAmount < 6 ? 2 : 3;
        const sustainedScore = totalRain12h < 2 ? 0 : totalRain12h < 8 ? 1 : totalRain12h < 20 ? 2 : 3;
        const rainSeverity  = Math.max(peakScore, sustainedScore);

        // --- Compute today's skating window (for debug) ---
        let todaySkatingStart = null, todaySkatingEnd = null;
        for (let di = 0; di < daily.time.length; di++) {
            const d = new Date(daily.time[di]); d.setHours(0,0,0,0);
            const tm = new Date(now); tm.setHours(0,0,0,0);
            if (d.getTime() !== tm.getTime()) continue;
            const sr = new Date(daily.sunrise[di]);
            const ss = new Date(daily.sunset[di]);
            if (!sr || !ss || isNaN(sr) || isNaN(ss)) break;
            const dlMs = ss - sr;
            todaySkatingStart = new Date(sr.getTime() + dlMs * 0.30);
            todaySkatingEnd   = new Date(ss.getTime() + dlMs * 0.10);
            break;
        }

        // --- Helper: get skating window for any day index ---
        const getWindow = (di) => {
            const sr = new Date(daily.sunrise[di]);
            const ss = new Date(daily.sunset[di]);
            if (!sr || !ss || isNaN(sr) || isNaN(ss)) return null;
            const dlMs = ss - sr;
            if (dlMs <= 0) return null;
            return {
                start: new Date(sr.getTime() + dlMs * 0.30),
                end:   new Date(ss.getTime() + dlMs * 0.10)
            };
        };

        // --- Classify past 48h into skating / non-skating blocks ---
        // For each past hourly reading, determine which window it falls in
        let skatingHumSum = 0, skatingHumCount = 0;
        let nightHumSum   = 0, nightHumCount   = 0;
        let skatingDewSum = 0, skatingDewCount = 0;
        let skatingWindSum = 0, skatingWindCount = 0;
        let skatingTempSum = 0, skatingTempCount = 0;
        let nightDewSum   = 0, nightDewCount   = 0;
        let minSkatingHum = null;
        let minSkatingDew = null;

        // Build a lookup of which hours are skating hours
        // For each past hour, check against all daily windows in our data
        for (const h of pastHours) {
            if (h.time < cutoff48h) break;
            // Skip hours during which it was still raining (not useful for drying assessment)
            if (lastRainTime && h.time < lastRainTime) continue;

            let inSkatingWindow = false;
            for (let di = 0; di < daily.time.length; di++) {
                const win = getWindow(di);
                if (!win) continue;
                if (h.time >= win.start && h.time <= win.end && h.time <= now) {
                    inSkatingWindow = true;
                    break;
                }
            }

            if (inSkatingWindow) {
                skatingHumSum   += h.humidity; skatingHumCount++;
                if (minSkatingHum === null || h.humidity < minSkatingHum) minSkatingHum = h.humidity;
                if (h.dewpoint !== null) {
                    skatingDewSum += h.dewpoint; skatingDewCount++;
                    if (minSkatingDew === null || h.dewpoint < minSkatingDew) minSkatingDew = h.dewpoint;
                }
                if (h.wind !== null) { skatingWindSum += h.wind; skatingWindCount++; }
                if (h.temp !== null) { skatingTempSum += h.temp; skatingTempCount++; }
            } else {
                nightHumSum += h.humidity; nightHumCount++;
                if (h.dewpoint !== null) { nightDewSum += h.dewpoint; nightDewCount++; }
            }
        }

        const avgSkatingHumidity = skatingHumCount > 0 ? Math.round(skatingHumSum / skatingHumCount) : null;
        const avgSkatingWind = skatingWindCount > 0 ? Math.round(skatingWindSum / skatingWindCount) : null;
        const avgSkatingTemp = skatingTempCount > 0 ? Math.round(skatingTempSum / skatingTempCount) : null;
        const avgNightHumidity   = nightHumCount   > 0 ? Math.round(nightHumSum   / nightHumCount)   : null;
        const avgNightDewpoint   = nightDewCount   > 0 ? parseFloat((nightDewSum  / nightDewCount).toFixed(1))  : null;
        const minDaytimeDewpoint = minSkatingDew;

        // Humidity delta: how much did daytime min drop below overnight average?
        // Small delta = poor drying. If no skating window data yet, use current humidity as proxy.
        let humidityDelta = null;
        if (avgNightHumidity !== null && minSkatingHum !== null) {
            humidityDelta = avgNightHumidity - minSkatingHum;
        }

        // --- Fallback: if no skating window data since rain, use PREVIOUS day's skating window min ---
        // (fixes the nighttime fallback bug — don't use raw nighttime humidity)
        let minDaytimeHumidity = minSkatingHum;
        if (minDaytimeHumidity === null) {
            // Find the most recently completed skating window before rain started
            for (let di = daily.time.length - 1; di >= 0; di--) {
                const win = getWindow(di);
                if (!win || win.end > now) continue;
                if (lastRainTime && win.end > lastRainTime) continue; // window was during/after rain
                let winMin = null;
                for (const h of pastHours) {
                    if (h.time >= win.start && h.time <= win.end) {
                        if (winMin === null || h.humidity < winMin) winMin = h.humidity;
                    }
                }
                if (winMin !== null) { minDaytimeHumidity = winMin; break; }
            }
            // Last resort: use forecast afternoon humidity if available
            if (minDaytimeHumidity === null && todaySkatingEnd && now < todaySkatingEnd) {
                const forecastAfternoon = [];
                for (let i = 0; i < hourly.time.length; i++) {
                    const t = new Date(hourly.time[i]);
                    if (t <= now || t > todaySkatingEnd) continue;
                    if (hourly.relative_humidity_2m[i] != null) forecastAfternoon.push(hourly.relative_humidity_2m[i]);
                }
                if (forecastAfternoon.length > 0) minDaytimeHumidity = Math.min(...forecastAfternoon);
            }
        }
        // Ultimate fallback: conservative
        if (minDaytimeHumidity === null) minDaytimeHumidity = 90;

        // --- Severity modifiers ---
        // +1 if dew point persistently high (air saturated, surfaces won't dry)
        let dewMod = 0;
        if (minDaytimeDewpoint !== null && minDaytimeDewpoint > 10) dewMod = +1;
        if (minDaytimeDewpoint !== null && minDaytimeDewpoint < 5)  dewMod = -1;

        // +1 if humidity barely dropped overnight → daytime (poor drying)
        let deltaMod = 0;
        if (humidityDelta !== null && humidityDelta < 10) deltaMod = +1;

        // Wind modifier: high wind dries faster, still air in damp conditions slows drying
        let windMod = 0;
        if (avgSkatingWind !== null) {
            if (avgSkatingWind > 20) windMod = -1;
            else if (avgSkatingWind < 5 && minDaytimeHumidity > 75) windMod = +1;
        }

        // --- Temperature-scaled drying power (applies beyond the 2h hard lock only — ---
        // --- that lock stays unconditional regardless of conditions) ---
        // Ambient drying modifiers (dew-point gap, wind) are only as effective as the
        // temperature allows: cold air has little real drying power even when windy/dry
        // (so a quick wet->dry swing shouldn't be trusted in winter), while warm air dries
        // genuinely fast (so summer conditions should be allowed to dry out sooner than
        // winter ones). Only ever weakens or strengthens an already-drying modifier —
        // never turns a dampening modifier into a drying one.
        const scaleDrying = (mod) => {
            if (mod >= 0 || avgSkatingTemp === null) return mod;
            if (avgSkatingTemp < 5)  return 0;       // cold: negligible drying power
            if (avgSkatingTemp > 15) return mod - 1; // warm: amplified drying power
            return mod;                              // mild: unchanged
        };
        dewMod = scaleDrying(dewMod);
        windMod = scaleDrying(windMod);

        // Frost note (informational only — not a severity change, just UI flag)
        const frostWarning = (currentWeather && currentWeather.temp <= 3 && minDaytimeDewpoint !== null && minDaytimeDewpoint < 0);

        // --- 48h stats for display ---
        const allHumidities = pastHours.filter(h => h.time >= cutoff48h).map(h => h.humidity);
        const avgHumidity48h = allHumidities.length > 0 ? Math.round(allHumidities.reduce((a,b)=>a+b,0)/allHumidities.length) : null;

        const extras = {
            accumulatedRain:      parseFloat(accumulatedRain48h.toFixed(1)),
            accumulatedRainEvent: parseFloat(accumulatedRainEvent.toFixed(1)),
            avgHumidity:          avgHumidity48h,
            avgSkatingHumidity,
            avgNightHumidity,
            minDaytimeHumidity,
            avgNightDewpoint,
            minDaytimeDewpoint,
            humidityDelta,
            avgSkatingWind,
            windMod,
            hoursSinceRain,
            lastRainTime,
            maxRainAmount:  parseFloat(maxRainAmount.toFixed(2)),
            totalRain12h:   parseFloat(totalRain12h.toFixed(1)),
            rainSeverity,
            rainDurationHours,
            hourlyLagged,
            unaccountedRain: parseFloat((unaccountedRain||0).toFixed(1)),
            todaySkatingStart,
            todaySkatingEnd,
            frostWarning,
            rawData: data
        };

        const rainAgoMsg = (h) => {
            if (hourlyLagged && h === 0) return `Rain today (${unaccountedRain.toFixed(1)}mm, data updating)`;
            return this._formatHoursSinceRainMessage(h);
        };

        // Helper: clamp a status given modifiers
        const BANDS = ['DRY', 'PATCHY', 'WET'];
        const applyMods = (baseIdx, ...mods) => {
            const idx = Math.max(0, Math.min(2, baseIdx + mods.reduce((a,b)=>a+b,0)));
            const status = BANDS[idx];
            const color  = ['green','yellow','red'][idx];
            const emoji  = ['🟢','🟡','🔴'][idx];
            return { status, color, emoji };
        };

        // --- No recent rain path ---
        // Still check humidity/dew point — handles persistent damp without measurable rain (CPP case).
        // No rain in the window → modifiers may only dry things out, never manufacture wetness;
        // humidity alone is capped below WET (no path to WET without actual rain).
        if (hoursSinceRain === null) {
            const base = minDaytimeHumidity > 78 ? 1 : 0; // DRY or PATCHY only
            const result = applyMods(base, Math.min(0, dewMod), Math.min(0, deltaMod), Math.min(0, windMod));
            const message = result.status === 'DRY' ? 'No rain 3+ days' : 'No rain · persistent damp';
            return this._applySkatingWindowOverride({ ...result, message, safe: result.status==='DRY', ...extras }, data, hourly, daily, now);
        }

        // --- DECISION MATRIX ---
        // Uses rainSeverity (0-3) + minDaytimeHumidity (78%/85% thresholds) + modifiers

        // 0–6h: WET if meaningful rain, PATCHY if trace rain
        // No modifiers during/just after active rain — wind/dew don't override wet road.
        // Exception: light, brief rain (severity 1, under ~12h of actual rain) doesn't
        // leave the same soaking as sustained or heavy rain, so it's allowed a PATCHY
        // floor instead of WET once past a shorter no-exceptions window.
        if (hoursSinceRain < 6) {
            const lightBriefRain = rainSeverity === 1 && rainDurationHours < 12;

            let base;
            if      (lightBriefRain)                                base = 1; // light, brief: PATCHY floor
            else if (rainSeverity >= 2 || minDaytimeHumidity > 85)   base = 2;
            else if (rainSeverity >= 1 || minDaytimeHumidity > 78)   base = 2;
            else                                                      base = 1; // trace rain only

            // Modifiers apply only when rain was light and some time has passed
            const noExceptionsWindow = lightBriefRain ? 1 : 2;
            if (hoursSinceRain < noExceptionsWindow || (!lightBriefRain && rainSeverity >= 1)) {
                // Active/recent meaningful rain — no modifier softening
                const idx = Math.max(0, Math.min(2, base));
                const BANDS2 = ['DRY','PATCHY','WET'];
                return { status: BANDS2[idx], color: ['green','yellow','red'][idx], emoji: ['🟢','🟡','🔴'][idx],
                    message: rainAgoMsg(hoursSinceRain), safe: false, ...extras };
            }
            // Light, brief rain's ambient modifiers may only dry things out further,
            // never push it back up toward WET — same rule as the no-rain-relevant
            // bands, since a short light shower doesn't leave the same soaking a
            // modifier should be allowed to "slow the drying of" (found 2026-11-12:
            // calm+humid windMod was silently re-inflating PATCHY back to WET here).
            const result = lightBriefRain
                ? applyMods(base, Math.min(0, dewMod), Math.min(0, windMod))
                : applyMods(base, dewMod, windMod);
            return this._applySkatingWindowOverride({ ...result, message: rainAgoMsg(hoursSinceRain), safe: false, ...extras }, data, hourly, daily, now);
        }

        // 6–12h
        if (hoursSinceRain < 12) {
            let base;
            if      (rainSeverity >= 2 || minDaytimeHumidity > 85) base = 2;
            else if (rainSeverity >= 1 || minDaytimeHumidity > 78) base = 1;
            else                                                    base = 0;
            const result = applyMods(base, dewMod, deltaMod, windMod);
            return this._applySkatingWindowOverride({ ...result, message: rainAgoMsg(hoursSinceRain), safe: result.status==='DRY', ...extras }, data, hourly, daily, now);
        }

        // 12–24h
        if (hoursSinceRain < 24) {
            let base;
            if      (rainSeverity >= 3 && minDaytimeHumidity > 78) base = 2;
            else if (rainSeverity >= 2 || minDaytimeHumidity > 85) base = 1;
            else if (rainSeverity >= 1 || minDaytimeHumidity > 78) base = 1;
            else                                                    base = 0;
            const result = applyMods(base, dewMod, deltaMod, windMod);
            return this._applySkatingWindowOverride({ ...result, message: rainAgoMsg(hoursSinceRain), safe: result.status==='DRY', ...extras }, data, hourly, daily, now);
        }

        // 24–48h
        if (hoursSinceRain < 48) {
            let base;
            if      (rainSeverity >= 3 && minDaytimeHumidity > 78) base = 2;
            else if (rainSeverity >= 2 || minDaytimeHumidity > 78) base = 1;
            else                                                    base = 0;
            const result = applyMods(base, dewMod, deltaMod, windMod);
            return this._applySkatingWindowOverride({ ...result, message: rainAgoMsg(hoursSinceRain), safe: result.status==='DRY', ...extras }, data, hourly, daily, now);
        }

        // 48h+: DRY unless modifiers push it up. Base stays hardcoded DRY (unchanged) —
        // but modifiers are now dry-only, so they can no longer manufacture PATCHY/WET
        // from ambient humidity/wind/dew alone with zero rain involved.
        const { status, color, emoji } = applyMods(0, Math.min(0, dewMod), Math.min(0, deltaMod), Math.min(0, windMod));
        return this._applySkatingWindowOverride({ status, color, emoji, message: rainAgoMsg(hoursSinceRain), safe: status==='DRY', ...extras }, data, hourly, daily, now);
    };

    /**
     * Override today's dot status with the worst remaining skating-window hour.
     * Called at end of calculateRoadCondition — ensures day dot always reflects
     * what skating hours actually look like from now onwards.
     */
    module._applySkatingWindowOverride = function(baseResult, data, hourly, daily, now) {
        if (!hourly || !daily) return baseResult;

        // Find today's skating window
        const todayMidnight = new Date(now); todayMidnight.setHours(0,0,0,0);
        let skWinStart = null, skWinEnd = null;
        for (let di = 0; di < daily.time.length; di++) {
            const d = new Date(daily.time[di]); d.setHours(0,0,0,0);
            if (d.getTime() !== todayMidnight.getTime()) continue;
            const sr = new Date(daily.sunrise[di]);
            const ss = new Date(daily.sunset[di]);
            if (!sr || !ss || isNaN(sr) || isNaN(ss)) break;
            const dlMs = ss - sr;
            skWinStart = new Date(sr.getTime() + dlMs * 0.30);
            skWinEnd   = new Date(ss.getTime() + dlMs * 0.10);
            break;
        }

        // If no skating window found, or skating window already fully past, return base
        if (!skWinStart || !skWinEnd || now > skWinEnd) return baseResult;

        // Get remaining skating-window hours (from now to end of window)
        const remainingStart = now > skWinStart ? now : skWinStart;
        const skatingHourScores = [];

        // Track lastRainIdx scanning forward through hourly to compute hoursSinceRain per slot
        let lastRainTime = baseResult.lastRainTime || null;
        let lastRainIdxLocal = null;

        for (let i = 0; i < hourly.time.length; i++) {
            const raw = hourly.time[i];
            const t = parseLocalTime(raw);

            if (t <= now) {
                if ((hourly.precipitation[i] || 0) > 0.1) { lastRainTime = t; lastRainIdxLocal = i; }
                continue;
            }
            if (t < remainingStart || t > skWinEnd) continue;

            const precip = hourly.precipitation[i] || 0;
            if (precip > 0.1) { lastRainTime = t; lastRainIdxLocal = i; }

            const hsr = lastRainTime !== null
                ? (precip > 0.1 ? 0 : Math.round((t - lastRainTime) / 3600000))
                : null;

            // Rain duration: consecutive hours of actual rain ending at lastRainIdxLocal —
            // distinct from severity (intensity/total amount).
            let rainDurationHours = 0;
            if (lastRainIdxLocal !== null) {
                for (let k = lastRainIdxLocal; k >= 0; k--) {
                    if ((hourly.precipitation[k] || 0) > 0.1) rainDurationHours++;
                    else break;
                }
            }

            // Rolling 12h severity
            const cutoff12h = new Date(t.getTime() - 12 * 3600000);
            let maxP = precip, tot12 = precip;
            for (let j = i - 1; j >= 0; j--) {
                const tj = hourly.time[j].includes('T') && !hourly.time[j].includes('Z') && !hourly.time[j].includes('+')
                    ? new Date(hourly.time[j] + ':00') : new Date(hourly.time[j]);
                if (tj < cutoff12h) break;
                const pj = hourly.precipitation[j] || 0;
                if (pj > maxP) maxP = pj;
                tot12 += pj;
            }
            const peakSev = maxP < 0.3 ? 0 : maxP < 3 ? 1 : maxP < 6 ? 2 : 3;
            const sustSev = tot12 < 2  ? 0 : tot12 < 8  ? 1 : tot12 < 20 ? 2 : 3;
            const sev = Math.max(peakSev, sustSev);

            const hum  = hourly.relative_humidity_2m[i] || 0;
            const dew  = hourly.dewpoint_2m ? (hourly.dewpoint_2m[i] ?? null) : null;
            const wind = hourly.windspeed_10m ? (hourly.windspeed_10m[i] ?? null) : null;
            const temp = hourly.temperature_2m ? (hourly.temperature_2m[i] ?? null) : null;

            skatingHourScores.push(this.scoreHourCondition(hsr, sev, hum, dew, wind, temp, rainDurationHours));
        }

        if (skatingHourScores.length === 0) return baseResult;

        // Day dot = worst among remaining skating hours
        // Single bad hour in a long window: downgrade WET → PATCHY
        const wetCount    = skatingHourScores.filter(s => s.status === 'WET').length;
        const patchyCount = skatingHourScores.filter(s => s.status === 'PATCHY').length;
        const total       = skatingHourScores.length;

        let status, color, emoji;
        if (wetCount > 1 || (wetCount === 1 && total <= 2)) {
            status = 'WET'; color = 'red'; emoji = '🔴';
        } else if (wetCount === 1) {
            status = 'PATCHY'; color = 'yellow'; emoji = '🟡';
        } else if (patchyCount > 0) {
            status = 'PATCHY'; color = 'yellow'; emoji = '🟡';
        } else {
            status = 'DRY'; color = 'green'; emoji = '🟢';
        }

        return { ...baseResult, status, color, emoji, safe: status === 'DRY' };
    };

    /**
     * Get upcoming 6h hourly forecast from now
     * Fills the gap between "now" and "tomorrow's daily card"
     */
    module.getUpcomingHourlyForecast = function(data) {
        if (!data.hourly) return [];
        const now = new Date();
        const cutoff = new Date(now.getTime() + 24 * 3600 * 1000); // next 24h
        const upcoming = [];

        for (let i = 0; i < data.hourly.time.length; i++) {
            const t = new Date(data.hourly.time[i]);
            if (t <= now) continue;
            if (t > cutoff) break;
            upcoming.push({
                time: t,
                hour: t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
                precipitation: data.hourly.precipitation[i] || 0,
                humidity: data.hourly.relative_humidity_2m[i] || 0,
                temperature: Math.round(data.hourly.temperature_2m[i])
            });
        }
        return upcoming;
    };

    /**
     * Get weather emoji from WMO code
     * WMO Weather interpretation codes (WW)
     */
    module.getWeatherEmoji = function(code) {
        const codeMap = {
            0: '☀️',   // Clear sky
            1: '🌤️',  // Mainly clear
            2: '⛅',  // Partly cloudy
            3: '☁️',   // Overcast
            45: '🌫️', // Fog
            48: '🌫️', // Depositing rime fog
            51: '🌦️', // Light drizzle
            53: '🌦️', // Moderate drizzle
            55: '🌧️',  // Dense drizzle
            61: '🌧️',  // Slight rain
            63: '🌧️',  // Moderate rain
            65: '🌧️',  // Heavy rain
            71: '🌨️', // Slight snow
            73: '🌨️', // Moderate snow
            75: '❄️',  // Heavy snow
            77: '❄️',  // Snow grains
            80: '🌦️', // Slight rain showers
            81: '🌧️',  // Moderate rain showers
            82: '⛈️',  // Violent rain showers
            85: '🌨️', // Slight snow showers
            86: '❄️',  // Heavy snow showers
            95: '⛈️',  // Thunderstorm
            96: '⛈️',  // Thunderstorm with slight hail
            99: '⛈️'   // Thunderstorm with heavy hail
        };
        return codeMap[code] || '🌤️';
    };

    /**
     * Get weather description from WMO code
     */
    module.getWeatherText = function(code) {
        const textMap = {
            0: 'Clear',
            1: 'Mostly Clear',
            2: 'Partly Cloudy',
            3: 'Overcast',
            45: 'Foggy',
            48: 'Foggy',
            51: 'Light Drizzle',
            53: 'Drizzle',
            55: 'Heavy Drizzle',
            61: 'Light Rain',
            63: 'Rain',
            65: 'Heavy Rain',
            71: 'Light Snow',
            73: 'Snow',
            75: 'Heavy Snow',
            77: 'Snow',
            80: 'Light Showers',
            81: 'Showers',
            82: 'Heavy Showers',
            85: 'Snow Showers',
            86: 'Heavy Snow',
            95: 'Thunderstorm',
            96: 'Thunderstorm',
            99: 'Severe Storm'
        };
        return textMap[code] || 'Unknown';
    };

    /**
     * Get wind direction arrow
     */
    module.getWindArrow = function(degrees) {
        if (degrees === null || degrees === undefined) return '→';
        const arrows = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];
        const index = Math.round(degrees / 45) % 8;
        return arrows[index];
    };

    console.log('✅ Weather module initialized (Open-Meteo)');
    return module;
}

// Log when script is loaded
console.log('📄 weatherModule.js loaded');
