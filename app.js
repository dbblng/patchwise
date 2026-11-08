const weatherModule = initWeatherModule();

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const copyRowEl = document.getElementById('copy-row');
const copyConfirmEl = document.getElementById('copy-confirm');
const searchResultsEl = document.getElementById('search-results');
const forecastStripEl = document.getElementById('forecast-strip');
const forecastDetailEl = document.getElementById('forecast-detail');

let lastSummary = '';
let rawHourly = null;

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

// Retroactive road-condition scoring for an elapsed/past 2h slot, using actual
// recorded conditions. Ported from uiModule.js's day-detail hourly strip (the main
// app computes this for any past hour, not just future-forecast ones) — kept as a
// faithful copy rather than touching weatherModule.js's scoreHourCondition.
function scorePastSlot(h, now) {
    let hsr = null;
    for (let ri = 0; ri < rawHourly.time.length; ri++) {
        const rt = parseLocalTime(rawHourly.time[ri]);
        if (rt >= h.t) break;
        if ((rawHourly.precipitation[ri] || 0) > 0.1) hsr = Math.round((h.t - rt) / 3600000);
    }
    const effHsr = h.precip > 0.1 ? 0 : hsr;
    const sev = h.precip >= 3 ? 2 : h.precip >= 0.3 ? 1 : 0;

    const slotTemp = rawHourly.temperature_2m ? (rawHourly.temperature_2m[h.i0] ?? null) : null;
    const slotDew = rawHourly.dewpoint_2m ? (rawHourly.dewpoint_2m[h.i0] ?? null) : null;
    let dewDeprMod = 0;
    if (slotTemp !== null && slotDew !== null) {
        const gap = slotTemp - slotDew;
        if (gap < 3) dewDeprMod = +1;
        else if (gap < 6) dewDeprMod = 0;
        else if (gap < 12) dewDeprMod = -1;
        else dewDeprMod = -2;
    }
    const slotWind = rawHourly.windspeed_10m ? (rawHourly.windspeed_10m[h.i0] ?? null) : null;
    let windMod = 0;
    if (slotWind !== null) {
        if (slotWind > 30) windMod = -2;
        else if (slotWind > 15) windMod = -1;
        else if (slotWind < 5) windMod = +1;
    }
    let tempMod = 0;
    if (slotTemp !== null) {
        if (slotTemp < 5) tempMod = +1;
        else if (slotTemp > 15) tempMod = -1;
    }
    const totalMod = Math.max(-2, Math.min(2, dewDeprMod + windMod + tempMod));
    const BANDS = ['green', 'yellow', 'red'];
    const applyMod = (base) => BANDS[Math.max(0, Math.min(2, base + totalMod))];

    let color;
    if (effHsr === null) {
        color = applyMod(h.hum > 85 ? 2 : h.hum > 78 ? 1 : 0);
    } else if (effHsr === 0) {
        color = 'red';
    } else if (effHsr < 2) {
        color = sev >= 1 ? 'red' : 'yellow';
    } else if (effHsr < 6) {
        let base = sev >= 3 ? 2 : (sev >= 2 && h.hum > 65) ? 2 : sev >= 2 ? 1
            : (sev >= 1 && h.hum > 65) ? 1 : sev >= 1 ? 1 : 0;
        const minIdx = (sev >= 2 || h.hum > 78) ? 1 : 0;
        color = BANDS[Math.max(minIdx, Math.min(2, base + totalMod))];
    } else if (effHsr < 12) {
        color = applyMod((sev >= 2 || h.hum > 85) ? 2 : (sev >= 1 || h.hum > 78) ? 1 : 0);
    } else if (effHsr < 24) {
        color = applyMod((sev >= 3 && h.hum > 78) ? 2 : (sev >= 2 || h.hum > 85) ? 1 : (sev >= 1 || h.hum > 78) ? 1 : 0);
    } else if (effHsr < 48) {
        color = applyMod((sev >= 3 && h.hum > 78) ? 2 : (sev >= 2 || h.hum > 78) ? 1 : 0);
    } else {
        color = applyMod(h.hum > 85 ? 2 : h.hum > 78 ? 1 : 0);
    }
    if (h.precip > 0.1 && color !== 'red') color = 'red';
    return color;
}

// Builds the 2h-paired slots for a given calendar day, matching uiModule.js exactly:
// precip summed, humidity/dew taken as the max (worst case) across the pair.
function buildDaySlots(dayDate, now) {
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
        return { t: h0.t, precip, hum, dew, isFuture: h0.t > now, i0: h0.i };
    });
}

function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('status-error', !!isError);
}

async function checkLocation(lat, lng, label) {
    setStatus('Checking…');
    resultEl.classList.add('hidden');
    copyRowEl.classList.add('hidden');
    forecastStripEl.classList.add('hidden');
    forecastDetailEl.classList.add('hidden');
    forecastDetailEl.innerHTML = '';
    searchResultsEl.classList.add('hidden');

    const data = await weatherModule.getForecast(lat, lng);
    if (!data || !data.roadCondition) {
        setStatus('Could not fetch weather data — try again.', true);
        return;
    }

    rawHourly = data.roadCondition.rawData ? data.roadCondition.rawData.hourly : null;

    setStatus('');
    renderResult(lat, lng, label, data);
    renderForecastStrip(data);
}

function renderResult(lat, lng, label, data) {
    const road = data.roadCondition;
    const current = data.current;

    const hrsVal = road.hoursSinceRain !== null && road.hoursSinceRain !== undefined
        ? (road.hoursSinceRain === 0 ? 'now' : road.hoursSinceRain + 'h')
        : '3d+';

    resultEl.innerHTML = `
        <div class="location-name">${label || 'Selected location'}</div>
        <div class="coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
        <div class="result-row">
            <div class="road-box road-${road.color}">
                <div class="road-dot">${road.emoji}</div>
                <div class="road-status">${road.status}</div>
                <div class="road-message">${road.message || ''}</div>
            </div>
            <div class="chips-col">
                <div class="weather-line">
                    ${current ? `${current.weatherEmoji || ''} ${current.temp}°C &middot; ${current.humidity}% &middot; ${current.windSpeed}km/h` : ''}
                </div>
                <div class="chips">
                    <span class="chip">💧 ${hrsVal} dry</span>
                    <span class="chip">12h ${road.totalRain12h != null ? road.totalRain12h + 'mm' : '--'}</span>
                    <span class="chip">48h ${road.accumulatedRain != null ? road.accumulatedRain + 'mm' : '--'}</span>
                    <span class="chip">sev ${road.rainSeverity != null ? road.rainSeverity + '/3' : '--'}</span>
                    <span class="chip">peak ${road.maxRainAmount != null ? road.maxRainAmount + 'mm/h' : '--'}</span>
                    <span class="chip">hum ${road.minDaytimeHumidity != null ? road.minDaytimeHumidity + '%' : '--'}</span>
                    <span class="chip">&Delta;${road.humidityDelta != null ? road.humidityDelta : '--'}</span>
                    <span class="chip">dew ${road.minDaytimeDewpoint != null ? road.minDaytimeDewpoint + '&deg;C' : '--'}</span>
                    <span class="chip">💨 ${road.avgSkatingWind != null ? road.avgSkatingWind + 'km/h' : '--'}</span>
                </div>
            </div>
        </div>
    `;
    resultEl.classList.remove('hidden');

    const now = new Date();
    lastSummary = `Patchwise — ${now.toLocaleString()}\n` +
        `Location: ${label ? label + ' — ' : ''}${lat.toFixed(5)}, ${lng.toFixed(5)}\n` +
        `Predicted: ${road.status} (${road.message || ''})\n` +
        `hoursSinceRain: ${hrsVal}, sev: ${road.rainSeverity}/3, hum: ${road.minDaytimeHumidity}%, ` +
        `dew: ${road.minDaytimeDewpoint}°C, wind: ${road.avgSkatingWind}km/h, Δ: ${road.humidityDelta}\n` +
        `Observed: [fill in what you actually see]\n` +
        `Notes: `;

    copyRowEl.classList.remove('hidden');
    copyConfirmEl.classList.add('hidden');
}

const TARGET_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

let currentDays = []; // unified list: [{...day, isPast}]

function renderForecastStrip(data) {
    if (!data.forecast || !data.forecast.length) return;

    const pastDays = (data.past ? [...data.past].reverse() : []).map(day => ({ ...day, isPast: true }));
    const forecastDays = data.forecast.map(day => ({ ...day, isPast: false }));
    currentDays = [...pastDays, ...forecastDays];

    forecastStripEl.innerHTML = currentDays.map((day, idx) => {
        if (day.isPast) {
            const sub = day.precipitation > 0.1 ? day.precipitation.toFixed(1) + 'mm' : 'dry';
            return `
                <div class="forecast-day past-day" data-idx="${idx}">
                    <div class="fd-name">${day.dayName}</div>
                    <div class="fd-weather">${day.weatherEmoji || ''} ${day.tempMin}&ndash;${day.tempMax}&deg;</div>
                    <div class="fd-dot fd-grey">⚪</div>
                    <div class="fd-status">${sub}</div>
                </div>
            `;
        }
        const fc = day.forecastCondition || { color: 'grey', emoji: '⚪', status: '--' };
        return `
            <div class="forecast-day" data-idx="${idx}">
                <div class="fd-name">${day.dayName}</div>
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

// Same tiers as uiModule.js's humC/dewC
const humC = h => h == null ? 'rdv-grey' : h < 70 ? 'rdv-green' : h < 78 ? 'rdv-lime' : h < 85 ? 'rdv-yellow' : 'rdv-red';
const dewC = d => d == null ? 'rdv-grey' : d < 5 ? 'rdv-green' : d < 10 ? 'rdv-lime' : d < 15 ? 'rdv-yellow' : 'rdv-red';

function renderHourBox(hour, slot, hourScores, now) {
    const timeLabel = String(hour).padStart(2, '0') + ':00';

    if (!slot) {
        return `
            <div class="upcoming-hour upcoming-forecast fh-empty-slot">
                <div class="upcoming-time">${timeLabel}</div>
            </div>
        `;
    }

    let color;
    if (slot.isFuture && hourScores) {
        const colorRank = { green: 0, yellow: 1, red: 2 };
        const makeKey = (hr) => slot.t.getFullYear() + '-' +
            String(slot.t.getMonth() + 1).padStart(2, '0') + '-' +
            String(slot.t.getDate()).padStart(2, '0') + 'T' +
            String(hr).padStart(2, '0');
        const s0 = hourScores[makeKey(slot.t.getHours())];
        const s1 = hourScores[makeKey(slot.t.getHours() + 1)];
        color = 'green';
        if (s0) color = s0.color;
        if (s1 && colorRank[s1.color] > colorRank[color]) color = s1.color;
    } else {
        color = scorePastSlot(slot, now);
    }
    if (slot.precip > 0.1 && color !== 'red') color = 'red';

    const hasRain = slot.precip > 0.1;
    const rainClass = hasRain ? 'upcoming-rain' : (slot.isFuture ? 'upcoming-forecast' : 'upcoming-dry');

    return `
        <div class="upcoming-hour ${rainClass}">
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
    const slots = rawHourly ? buildDaySlots(dayDate, now) : [];
    const slotByHour = {};
    slots.forEach(s => { slotByHour[s.t.getHours()] = s; });

    const hourRows = TARGET_HOURS.map(hour =>
        renderHourBox(hour, slotByHour[hour] || null, day.hourScores, now)
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

document.getElementById('copy-btn').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(lastSummary);
        copyConfirmEl.classList.remove('hidden');
        setTimeout(() => copyConfirmEl.classList.add('hidden'), 2000);
    } catch (e) {
        setStatus('Could not copy — select and copy manually.', true);
    }
});
