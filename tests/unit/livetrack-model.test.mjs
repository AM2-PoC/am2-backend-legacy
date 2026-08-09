import test from 'node:test';
import assert from 'node:assert/strict';
import {
    accuracyQuality, classifyUnit, formatAccuracy, formatAge, hasValidLocation, summarizeUnits,
} from '../../WebAdmin/asset/js/src/livetrack-model.js';

test('classification keeps identity freshness and TX independent', () => {
    assert.deepEqual(classifyUnit({ entity_type: 'tracker', freshness: 'delayed', is_speaking: 1 }), {
        entityType: 'tracker', freshness: 'delayed', speaking: true,
        markerClass: 'custom-marker entity-tracker freshness-delayed speaking-marker',
    });
});

test('unknown values fail safe instead of looking current', () => {
    assert.equal(classifyUnit({ entity_type: 'car', freshness: 'new' }).entityType, 'user');
    assert.equal(classifyUnit({ entity_type: 'car', freshness: 'new' }).freshness, 'stale');
});

test('age boundaries match API contract', () => {
    assert.equal(formatAge(null), '—');
    assert.equal(formatAge(0), '0s');
    assert.equal(formatAge(59), '59s');
    assert.equal(formatAge(60), '1m');
    assert.equal(formatAge(300), '5m');
    assert.equal(formatAge(3600), '1h');
});

test('accuracy quality does not convert absent data into zero metres', () => {
    assert.equal(accuracyQuality(null), 'unknown');
    assert.equal(accuracyQuality(-1), 'unknown');
    assert.equal(accuracyQuality(Number.NaN), 'unknown');
    assert.equal(accuracyQuality(42), 'good');
    assert.equal(accuracyQuality(101), 'poor');
    assert.equal(formatAccuracy(null), '—');
    assert.equal(formatAccuracy(42.4), '±42 m');
    assert.equal(formatAccuracy(1250), '±1.3 km');
});

test('coordinate validation requires both values in range and rejects null island', () => {
    assert.equal(hasValidLocation({ has_location: true, lat: -6.2, lng: 106.8 }), true);
    assert.equal(hasValidLocation({ has_location: 't', lat: '-6.2', lng: '106.8' }), true);
    assert.equal(hasValidLocation({ has_location: true, lat: 0, lng: 0 }), false);
    assert.equal(hasValidLocation({ has_location: true, lat: null, lng: null }), false);
    assert.equal(hasValidLocation({ has_location: true, lat: -6.2, lng: 181 }), false);
    assert.equal(hasValidLocation({ has_location: false, lat: -6.2, lng: 106.8 }), false);
});

test('summary separates socket presence from usable current location', () => {
    const summary = summarizeUnits([
        { is_online: 1, has_location: true, lat: -6.2, lng: 106.8, freshness: 'fresh', entity_type: 'user' },
        { is_online: 1, has_location: true, lat: -6.21, lng: 106.81, freshness: 'delayed', entity_type: 'tracker' },
        { is_online: 1, has_location: false, freshness: 'stale', entity_type: 'user' },
    ]);
    assert.deepEqual(summary, {
        online: 3, fresh: 1, delayed: 1, stale: 0, noLocation: 1, users: 2, trackers: 1,
    });
});
