const weatherModule = initWeatherModule();

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const copyRowEl = document.getElementById('copy-row');
const copyConfirmEl = document.getElementById('copy-confirm');
const searchResultsEl = document.getElementById('search-results');
const forecastStripEl = document.getElementById('forecast-strip');
const forecastDetailEl = document.getElementById('forecast-detail');
const observedBlockEl = document.getElementById('observed-block');
const notesInputEl = document.getElementById('notes-input');

let lastCheck = null; // { lat, lng, label, road, hrsVal, slotStatus, checkedAt }
let selectedObserved = null;
let rawHourly = null;
let allHourScores = null; // unified hour-score lookup from processForecast, covers every hour

// Mirrors weatherModule.js's internal parseLocalTime — replicated here rather than
// touching the shared algorithm file for a display-only lookup.
function parseLocalTime(raw) {
    if (!raw) return new Date(NaN);
    if (raw.includes('Z') || raw.includes('+')) return new Date(raw);
    const [datePart, timePart = '00:00'] = raw.split('T');
    const [yr, mo, dy] = datePart.split('-').map(Number);
    const [hr, mn] = timePart.split(':').map(Number);
    return new Date(yr, mo - 1, dy, hr, mn, 0, 0);
}

// Builds the 2h-paired slots for a given calendar day, matching uiModule.js exactly:
// precip summed, humidity/dew taken as the max (worst case) across the pair.
// skStart/skEnd (optional) mark the day's skating window for the inSkWin flag.
function buildDaySlots(dayDate, now, skStart, skEnd) {
    const dayEnd = new Date(dayDate.getTime() + 24 * 3600000);
    const rawSlots = [];
    for (let i = 0; i < rawHourly.time.length; i++) {
        const t = parseLocalTime(rawHourly.time[i]);
        if (t < dayDate || t >= dayEnd) continue;
        const rawHour = parseInt(rawHourly.time[i].slice(11, 13), 10);
        if (rawHour % 2 !== 0) continue;
        rawSlots.push({
            t, i,
            precip: rawHourly.precipitation[i] || 0,
            hum: rawHourly.relative_humidity_2m[i] || 0,
            dew: rawHourly.dewpoint_2m ? (rawHourly.dewpoint_2m[i] != null ? Math.round(rawHourly.dewpoint_2m[i]) : null) : null
        });
    }

    return rawSlots.map(h0 => {
        const nextI = h0.i + 1;
        const h1 = (nextI < rawHourly.time.length) ? {
            t: parseLocalTime(rawHourly.time[nextI]),
            i: nextI,
            precip: rawHourly.precipitation[nextI] || 0,
            hum: rawHourly.relative_humidity_2m[nextI] || 0,
            dew: rawHourly.dewpoint_2m ? (rawHourly.dewpoint_2m[nextI] != null ? Math.round(rawHourly.dewpoint_2m[nextI]) : null) : null
        } : null;
        const precip = h0.precip + (h1 ? h1.precip : 0);
        const hum = h1 ? Math.max(h0.hum, h1.hum) : h0.hum;
        const dew = (h0.dew !== null && h1 && h1.dew !== null)
            ? Math.max(h0.dew, h1.dew)
            : (h0.dew !== null ? h0.dew : (h1 ? h1.dew : null));
        const inSkWin = skStart && skEnd
            ? (h0.t >= skStart && h0.t < skEnd) || (h1 && h1.t >= skStart && h1.t < skEnd)
            : false;
        return { t: h0.t, precip, hum, dew, isFuture: h0.t > now, inSkWin, i0: h0.i };
    });
}

function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('status-error', !!isError);
}

function resetUI(clearSearch) {
    resultEl.classList.add('hidden');
    resultEl.innerHTML = '';
    copyRowEl.classList.add('hidden');
    observedBlockEl.classList.add('hidden');
    forecastStripEl.classList.add('hidden');
    forecastStripEl.innerHTML = '';
    forecastDetailEl.classList.add('hidden');
    forecastDetailEl.innerHTML = '';
    searchResultsEl.classList.add('hidden');
    searchResultsEl.innerHTML = '';
    notesInputEl.value = '';
    selectedObserved = null;
    lastCheck = null;
    rawHourly = null;
    allHourScores = null;
    openDayIdx = null;
    setStatus('');
    if (clearSearch) document.getElementById('search-input').value = '';
}

async function checkLocation(lat, lng, label) {
    resetUI(false);
    setStatus('Checking…');

    const data = await weatherModule.getForecast(lat, lng);
    if (!data || !data.roadCondition) {
        setStatus('Could not fetch weather data — try again.', true);
        return;
    }

    rawHourly = data.roadCondition.rawData ? data.roadCondition.rawData.hourly : null;
    allHourScores = (data.forecast && data.forecast.allHourScores) || null;

    setStatus('');
    renderResult(lat, lng, label, data);
    renderForecastStrip(data);
}

// Big-box dot color + message: derives from the unified hour-score lookup (the
// current 2h slot containing "now"), same source of truth as the hourly strip — not
// from calculateRoadCondition's own independent status/message. Returns
// {color, message} or null if the lookup has no data (e.g. incomplete API response),
// in which case callers fall back to road.color/road.message.
function getCurrentSlotColor(data, now) {
    if (!rawHourly || !data.forecast || !data.forecast.allHourScores) return null;
    const allHourScores = data.forecast.allHourScores;
    const colorRank = { green: 0, yellow: 1, red: 2 };
    const makeKey = (t) => t.getFullYear() + '-' +
        String(t.getMonth()+1).padStart(2,'0') + '-' +
        String(t.getDate()).padStart(2,'0') + 'T' +
        String(t.getHours()).padStart(2,'0');

    for (let i = 0; i < rawHourly.time.length; i++) {
        const t = parseLocalTime(rawHourly.time[i]);
        const rawHour = parseInt(rawHourly.time[i].slice(11, 13), 10);
        if (rawHour % 2 !== 0) continue;
        const slotEnd = new Date(t.getTime() + 2 * 3600000);
        if (t <= now && now < slotEnd) {
            const nextI = i + 1 < rawHourly.time.length ? i + 1 : null;
            const s0 = allHourScores[makeKey(t)];
            const t1 = nextI !== null ? parseLocalTime(rawHourly.time[nextI]) : null;
            const s1 = t1 ? allHourScores[makeKey(t1)] : null;
            let col = s0 ? s0.color : null;
            if (s1 && colorRank[s1.color] > colorRank[col || 'green']) col = s1.color;
            const p0 = rawHourly.precipitation[i] || 0;
            const p1 = nextI !== null ? (rawHourly.precipitation[nextI] || 0) : 0;
            if ((p0 + p1) > 0.1) col = 'red';
            // Message travels with the slot's own score so the subtext under the big
            // dot can never contradict the hour that's actually driving its color.
            const message = s0 ? s0.message : null;
            return { color: col, message };
        }
    }
    return null;
}

function renderResult(lat, lng, label, data) {
    const road = data.roadCondition;
    const current = data.current;

    const hrsVal = road.hoursSinceRain !== null && road.hoursSinceRain !== undefined
        ? (road.hoursSinceRain === 0 ? 'now' : road.hoursSinceRain + 'h')
        : '3d+';

    const slot = getCurrentSlotColor(data, new Date());
    const slotColor   = (slot && slot.color) || road.color;
    const slotEmoji   = { green: '🟢', yellow: '🟡', red: '🔴' }[slotColor] || road.emoji;
    const slotStatus  = { green: 'DRY', yellow: 'PATCHY', red: 'WET' }[slotColor] || road.status;
    const slotMessage = (slot && slot.message) || road.message;

    const lagNote = road.hourlyLagged ? ` <span class="road-lag-inline">⚠️ +${road.unaccountedRain}mm lag</span>` : '';
    const skWin = (road.todaySkatingStart && road.todaySkatingEnd)
        ? new Date(road.todaySkatingStart).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) + '–' + new Date(road.todaySkatingEnd).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})
        : null;
    const omLink = `<a class="road-detail-link" href="https://open-meteo.com/en/docs#latitude=${lat}&longitude=${lng}" target="_blank">Open-Meteo →</a>`;

    resultEl.innerHTML = `
        <div class="location-name">${label || 'Selected location'}</div>
        <div class="coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
        <div class="result-row">
            <div class="road-box road-${slotColor}">
                <div class="road-dot">${slotEmoji}</div>
                <div class="road-status">${slotStatus}</div>
                <div class="road-message">${slotMessage || ''}</div>
            </div>
            <div class="chips-col">
                <div class="weather-line">
                    ${current ? `${current.weatherEmoji || ''} ${current.temp}°C &middot; ${current.humidity}% &middot; ${current.windSpeed}km/h` : ''}
                </div>
                <div class="chips">
                    <span class="chip ${hrsC(road.hoursSinceRain)}">💧 ${hrsVal} dry</span>${lagNote}
                    <span class="chip ${rain12C(road.totalRain12h)}">12h ${road.totalRain12h != null ? road.totalRain12h + 'mm' : '--'}</span>
                    <span class="chip ${rain48C(road.accumulatedRain)}">48h ${road.accumulatedRain != null ? road.accumulatedRain + 'mm' : '--'}</span>
                    <span class="chip ${sev3C(road.rainSeverity)}">sev ${road.rainSeverity != null ? road.rainSeverity + '/3' : '--'}</span>
                    <span class="chip ${peakC(road.maxRainAmount)}">peak ${road.maxRainAmount != null ? road.maxRainAmount + 'mm/h' : '--'}</span>
                    <span class="chip ${humC(road.minDaytimeHumidity)}">hum ${road.minDaytimeHumidity != null ? road.minDaytimeHumidity + '%' : '--'}</span>
                    <span class="chip ${deltaC(road.humidityDelta)}">&Delta;${road.humidityDelta != null ? road.humidityDelta : '--'}</span>
                    <span class="chip ${dewC(road.minDaytimeDewpoint)}">dew ${road.minDaytimeDewpoint != null ? road.minDaytimeDewpoint + '&deg;C' : '--'}${road.frostWarning ? ' ⚠️' : ''}</span>
                    <span class="chip ${windC(road.avgSkatingWind, road.windMod)}">💨 ${road.avgSkatingWind != null ? road.avgSkatingWind + 'km/h' : '--'}${road.windMod === -1 ? ' dry↑' : road.windMod === 1 ? ' still↓' : ''}</span>
                    ${skWin ? `<span class="chip rdv-grey">🛹 ${skWin}</span>` : ''}
                    ${omLink}
                </div>
            </div>
        </div>
    `;
    resultEl.classList.remove('hidden');

    lastCheck = { lat, lng, label, road, hrsVal, slotStatus, slotMessage, checkedAt: new Date() };

    selectedObserved = null;
    notesInputEl.value = '';
    document.querySelectorAll('.obs-btn').forEach(b => b.classList.remove('obs-selected'));
    observedBlockEl.classList.remove('hidden');

    copyRowEl.classList.remove('hidden');
    copyConfirmEl.classList.add('hidden');
}

function buildSummary() {
    if (!lastCheck) return '';
    const { lat, lng, label, road, hrsVal, slotStatus, slotMessage, checkedAt } = lastCheck;
    const notes = notesInputEl.value.trim();
    return `Patchwise — ${checkedAt.toLocaleString()}\n` +
        `Location: ${label ? label + ' — ' : ''}${lat.toFixed(5)}, ${lng.toFixed(5)}\n` +
        `Predicted: ${slotStatus} (${slotMessage || ''})\n` +
        `hoursSinceRain: ${hrsVal}, sev: ${road.rainSeverity}/3, hum: ${road.minDaytimeHumidity}%, ` +
        `dew: ${road.minDaytimeDewpoint}°C, wind: ${road.avgSkatingWind}km/h, Δ: ${road.humidityDelta}\n` +
        `Observed: ${selectedObserved || '(not set)'}\n` +
        `Notes: ${notes}`;
}

const TARGET_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

let currentDays = []; // unified list: [{...day, isPast}]

function renderForecastStrip(data) {
    if (!data.forecast || !data.forecast.length) return;

    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
    const isTodayDate = (d) => { const dd = new Date(d); dd.setHours(0, 0, 0, 0); return dd.getTime() === todayMidnight.getTime(); };

    const pastDays = (data.past ? [...data.past].reverse() : []).map(day => ({ ...day, isPast: true, isToday: false }));
    const forecastDays = data.forecast.map(day => ({ ...day, isPast: false, isToday: isTodayDate(day.date) }));
    currentDays = [...pastDays, ...forecastDays];

    forecastStripEl.innerHTML = currentDays.map((day, idx) => {
        const dayName = day.isToday ? 'Today' : day.dayName;
        if (day.isPast) {
            const sub = day.precipitation > 0.1 ? day.precipitation.toFixed(1) + 'mm' : 'dry';
            return `
                <div class="forecast-day past-day" data-idx="${idx}">
                    <div class="fd-name">${dayName}</div>
                    <div class="fd-weather">${day.weatherEmoji || ''} ${day.tempMin}&ndash;${day.tempMax}&deg;</div>
                    <div class="fd-dot fd-grey">⚪</div>
                    <div class="fd-status">${sub}</div>
                </div>
            `;
        }
        const fc = day.forecastCondition || { color: 'grey', emoji: '⚪', status: '--' };
        return `
            <div class="forecast-day${day.isToday ? ' fd-today' : ''}" data-idx="${idx}">
                <div class="fd-name">${dayName}</div>
                <div class="fd-weather">${day.weatherEmoji || ''} ${day.tempMin}&ndash;${day.tempMax}&deg;</div>
                <div class="fd-dot fd-${fc.color}">${fc.emoji}</div>
                <div class="fd-status">${fc.status}</div>
            </div>
        `;
    }).join('');
    forecastStripEl.classList.remove('hidden');

    forecastStripEl.querySelectorAll('.forecast-day').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            toggleForecastDetail(currentDays[idx], el);
        });
    });
}

let openDayIdx = null;

// Same tiers as uiModule.js's chip colour classifiers
const humC    = h => h == null ? 'rdv-grey' : h < 70 ? 'rdv-green' : h < 78 ? 'rdv-lime' : h < 85 ? 'rdv-yellow' : 'rdv-red';
const dewC    = d => d == null ? 'rdv-grey' : d < 5 ? 'rdv-green' : d < 10 ? 'rdv-lime' : d < 15 ? 'rdv-yellow' : 'rdv-red';
const hrsC    = h => h === null || h === undefined ? 'rdv-grey' : h === 0 ? 'rdv-red' : h < 6 ? 'rdv-red' : h < 12 ? 'rdv-orange' : h < 24 ? 'rdv-yellow' : h < 48 ? 'rdv-lime' : 'rdv-green';
const rain12C = r => r == null ? 'rdv-grey' : r < 1 ? 'rdv-green' : r < 3 ? 'rdv-lime' : r < 8 ? 'rdv-yellow' : 'rdv-red';
const rain48C = r => r == null ? 'rdv-grey' : r < 2 ? 'rdv-green' : r < 8 ? 'rdv-lime' : r < 20 ? 'rdv-yellow' : 'rdv-red';
const sev3C   = s => s == null ? 'rdv-grey' : s === 0 ? 'rdv-green' : s === 1 ? 'rdv-lime' : s === 2 ? 'rdv-yellow' : 'rdv-red';
const peakC   = r => r == null ? 'rdv-grey' : r < 1 ? 'rdv-green' : r < 3 ? 'rdv-lime' : r < 6 ? 'rdv-yellow' : 'rdv-red';
const deltaC  = d => d == null ? 'rdv-grey' : d > 20 ? 'rdv-green' : d > 10 ? 'rdv-lime' : d > 5 ? 'rdv-yellow' : 'rdv-red';
const windC   = (w, wMod) => w == null ? 'rdv-grey' : w > 20 ? 'rdv-green' : w < 5 && wMod === 1 ? 'rdv-red' : 'rdv-grey';

function renderHourBox(hour, slot, hourScores, nowPct) {
    const timeLabel = String(hour).padStart(2, '0') + ':00';
    const nowLineHtml = (nowPct !== null && nowPct !== undefined)
        ? `<div class="now-line" style="left:${nowPct}%"></div>`
        : '';

    if (!slot) {
        return `
            <div class="upcoming-hour upcoming-forecast fh-empty-slot">
                ${nowLineHtml}
                <div class="upcoming-time">${timeLabel}</div>
            </div>
        `;
    }

    // Future slots use the day's own hourScores; past slots now read from the
    // unified allHourScores lookup (built in processForecast with a real 12h-window
    // rainSeverity) instead of the old scorePastSlot re-derivation.
    const source = slot.isFuture ? hourScores : allHourScores;
    let color = 'green';
    if (source) {
        const colorRank = { green: 0, yellow: 1, red: 2 };
        const makeKey = (hr) => slot.t.getFullYear() + '-' +
            String(slot.t.getMonth() + 1).padStart(2, '0') + '-' +
            String(slot.t.getDate()).padStart(2, '0') + 'T' +
            String(hr).padStart(2, '0');
        const s0 = source[makeKey(slot.t.getHours())];
        const s1 = source[makeKey(slot.t.getHours() + 1)];
        if (s0) color = s0.color;
        if (s1 && colorRank[s1.color] > colorRank[color]) color = s1.color;
    }
    if (slot.precip > 0.1 && color !== 'red') color = 'red';

    const hasRain = slot.precip > 0.1;
    const rainClass = hasRain ? 'upcoming-rain' : (slot.isFuture ? 'upcoming-forecast' : 'upcoming-dry');
    const skClass = slot.inSkWin ? ' road-hour-skwin' : '';

    return `
        <div class="upcoming-hour ${rainClass}${skClass}">
            ${nowLineHtml}
            <div class="upcoming-time">${timeLabel}</div>
            <div class="weather-cond-dot weather-cond-${color}" title="Road condition"></div>
            <div class="upcoming-precip" title="Precipitation">${hasRain ? slot.precip.toFixed(1) + 'mm' : '—'}</div>
            <div class="upcoming-hum ${humC(slot.hum)}" title="Relative humidity">${slot.hum}%</div>
            ${slot.dew !== null ? `<div class="upcoming-dew ${dewC(slot.dew)}" title="Dew point">${slot.dew}&deg;</div>` : ''}
        </div>
    `;
}

function toggleForecastDetail(day, dayEl) {
    const idx = parseInt(dayEl.dataset.idx, 10);
    forecastStripEl.querySelectorAll('.forecast-day').forEach(el => el.classList.remove('fd-open'));

    if (openDayIdx === idx) {
        openDayIdx = null;
        forecastDetailEl.classList.add('hidden');
        forecastDetailEl.innerHTML = '';
        return;
    }
    openDayIdx = idx;
    dayEl.classList.add('fd-open');

    const now = new Date();
    const dayDate = new Date(day.date);
    dayDate.setHours(0, 0, 0, 0);
    const skStart = day.skatingStart ? new Date(day.skatingStart) : null;
    const skEnd   = day.skatingEnd   ? new Date(day.skatingEnd)   : null;
    const slots = rawHourly ? buildDaySlots(dayDate, now, skStart, skEnd) : [];
    const slotByHour = {};
    slots.forEach(s => { slotByHour[s.t.getHours()] = s; });

    // NOW line: find which 2h box (if any, today only) contains the current time,
    // and how far through that box "now" is — ported from the main app's
    // uiModule.js day-detail strip (same nowSlotIdx/nowPct behaviour).
    const todayMidnight = new Date(now); todayMidnight.setHours(0, 0, 0, 0);
    const isToday = dayDate.getTime() === todayMidnight.getTime();
    let nowSlotHour = null, nowPct = null;
    if (isToday) {
        for (const h of TARGET_HOURS) {
            const slotStart = new Date(dayDate); slotStart.setHours(h, 0, 0, 0);
            const slotEnd = new Date(slotStart.getTime() + 2 * 3600000);
            if (now >= slotStart && now < slotEnd) {
                nowSlotHour = h;
                nowPct = Math.round(((now - slotStart) / (2 * 3600000)) * 100);
                break;
            }
        }
        // If now is past all slots (e.g. checked at 23:xx), put the line at the
        // right edge of the last slot instead of showing nothing.
        if (nowSlotHour === null) {
            const lastHour = TARGET_HOURS[TARGET_HOURS.length - 1];
            const lastSlotStart = new Date(dayDate); lastSlotStart.setHours(lastHour, 0, 0, 0);
            if (now >= lastSlotStart) { nowSlotHour = lastHour; nowPct = 100; }
        }
    }

    const hourRows = TARGET_HOURS.map(hour =>
        renderHourBox(hour, slotByHour[hour] || null, day.hourScores, hour === nowSlotHour ? nowPct : null)
    ).join('');

    forecastDetailEl.innerHTML = `
        <div class="fd-detail-header">
            ${day.dayName} &middot; ${day.tempMin}&deg;&ndash;${day.tempMax}&deg;C &middot;
            ${day.precipitation}mm &middot; ${day.windSpeed}km/h ${day.windArrow || ''}
            ${day.skatingStart && day.skatingEnd ? `&middot; skating window ${new Date(day.skatingStart).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}&ndash;${new Date(day.skatingEnd).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}` : ''}
        </div>
        <div class="fh-grid">${hourRows}</div>
    `;
    forecastDetailEl.classList.remove('hidden');
}

document.getElementById('gps-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
        setStatus('Geolocation not supported on this browser/device.', true);
        return;
    }
    setStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
        (pos) => checkLocation(pos.coords.latitude, pos.coords.longitude, 'My Location'),
        (err) => setStatus('Could not get location: ' + err.message, true),
        { enableHighAccuracy: true, timeout: 10000 }
    );
});

async function searchPlace() {
    const q = document.getElementById('search-input').value.trim();
    if (!q) return;
    setStatus('Searching…');
    searchResultsEl.classList.add('hidden');

    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`;
        const res = await fetch(url);
        const results = await res.json();

        if (!results.length) {
            setStatus('No results found.', true);
            return;
        }

        setStatus('');
        searchResultsEl.innerHTML = results.map((r, i) => `
            <div class="search-result" data-idx="${i}">${r.display_name}</div>
        `).join('');
        searchResultsEl.classList.remove('hidden');

        searchResultsEl.querySelectorAll('.search-result').forEach(el => {
            el.addEventListener('click', () => {
                const r = results[parseInt(el.dataset.idx, 10)];
                const name = r.display_name.split(',')[0];
                document.getElementById('search-input').value = name;
                searchResultsEl.classList.add('hidden');
                checkLocation(parseFloat(r.lat), parseFloat(r.lon), name);
            });
        });
    } catch (e) {
        setStatus('Search failed — try again.', true);
    }
}

document.getElementById('search-btn').addEventListener('click', searchPlace);
document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchPlace();
});

document.querySelectorAll('.obs-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        selectedObserved = btn.dataset.status;
        document.querySelectorAll('.obs-btn').forEach(b => b.classList.remove('obs-selected'));
        btn.classList.add('obs-selected');
    });
});

document.getElementById('copy-btn').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(buildSummary());
        copyConfirmEl.classList.remove('hidden');
        setTimeout(() => copyConfirmEl.classList.add('hidden'), 2000);
    } catch (e) {
        setStatus('Could not copy — select and copy manually.', true);
    }
});

document.getElementById('reset-btn').addEventListener('click', () => {
    resetUI(true);
});
