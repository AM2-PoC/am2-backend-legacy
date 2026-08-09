export const ENTITY_TYPES = new Set(['user', 'tracker']);
export const FRESHNESS = new Set(['fresh', 'delayed', 'stale']);
export const POOR_ACCURACY_METERS = 100;

export function classifyUnit(unit = {}) {
    const entityType = ENTITY_TYPES.has(unit.entity_type) ? unit.entity_type : 'user';
    const freshness = FRESHNESS.has(unit.freshness) ? unit.freshness : 'stale';
    const speaking = Number(unit.is_speaking) === 1 || unit.is_speaking === true;
    const classes = ['custom-marker', `entity-${entityType}`, `freshness-${freshness}`];
    if (speaking) classes.push('speaking-marker');
    return { entityType, freshness, speaking, markerClass: classes.join(' ') };
}

export function formatAge(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '—';
    const age = Math.floor(Number(seconds));
    if (age < 60) return `${age}s`;
    if (age < 3600) return `${Math.floor(age / 60)}m`;
    if (age < 86400) return `${Math.floor(age / 3600)}h`;
    return `${Math.floor(age / 86400)}d`;
}

export function accuracyQuality(meters) {
    if (meters === null || meters === undefined || !Number.isFinite(Number(meters)) || Number(meters) < 0) return 'unknown';
    return Number(meters) > POOR_ACCURACY_METERS ? 'poor' : 'good';
}

export function formatAccuracy(meters) {
    if (accuracyQuality(meters) === 'unknown') return '—';
    const value = Number(meters);
    return value >= 1000 ? `±${(value / 1000).toFixed(1)} km` : `±${Math.round(value)} m`;
}

export function hasValidLocation(unit = {}) {
    const lat = unit.lat === null || unit.lat === '' ? Number.NaN : Number(unit.lat);
    const lng = unit.lng === null || unit.lng === '' ? Number.NaN : Number(unit.lng);
    const serverAcceptsLocation = unit.has_location === true || unit.has_location === 1
        || unit.has_location === '1' || unit.has_location === 't';
    return serverAcceptsLocation
        && Number.isFinite(lat) && Number.isFinite(lng)
        && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
        && !(lat === 0 && lng === 0);
}

export function summarizeUnits(units = []) {
    return units.reduce((summary, unit) => {
        if (Number(unit.is_online) === 1 || unit.is_online === true) summary.online += 1;
        if (hasValidLocation(unit)) {
            const freshness = FRESHNESS.has(unit.freshness) ? unit.freshness : 'stale';
            summary[freshness] += 1;
        } else {
            summary.noLocation += 1;
        }
        const entity = unit.entity_type === 'tracker' ? 'trackers' : 'users';
        summary[entity] += 1;
        return summary;
    }, { online: 0, fresh: 0, delayed: 0, stale: 0, noLocation: 0, users: 0, trackers: 0 });
}
