import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * "Gagal memperbarui fitur", on a switch that was never the problem.
 *
 * Reported as an expired session, and it was not one. A feature refusal comes
 * back as HTTP 200 with success=false, deliberately -- a refusal is not an
 * expired session, and giving it a 4xx would sign an administrator out for
 * touching something outside their rights. But the app threw the server's
 * explanation away and showed one hardcoded sentence, so a refused right, an
 * unrecognised value and a database error all read the same and none of them
 * pointed anywhere.
 *
 * Every feature refusal recorded on production carries reason=admin-lacks-right
 * -- nineteen of them, the most recent on 2 September -- and the message the
 * server sent for each was "Akses ditolak". Nobody was ever shown it.
 *
 * The other half is that the log could not tell an administrator who lacks a
 * right from a lookup that found no administrator at all: both refuse, both
 * said admin-lacks-right, and with every administrator holding every right the
 * production log could not settle which had happened.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const features = read('WebAdmin/user_features.php');
const apiUsers = read('WebAdmin/api_users.php');

test('a refusal keeps its 200, so it cannot be mistaken for an expired session', () => {
    // The app signs out on 401 only. A refusal answered with 401 or 403 would
    // sign an administrator out for lacking a right, which is a worse bug than
    // the one being fixed.
    const block = apiUsers.slice(apiUsers.indexOf("elseif ($action == 'update_feature')"),
                                 apiUsers.indexOf("elseif ($action == 'update_feature')") + 3000);
    const catches = block.slice(block.indexOf('} catch ('));
    assert.doesNotMatch(catches, /http_response_code\(4\d\d\)/,
        'a business refusal now carries a status the session interceptor reacts to');
    assert.match(catches, /'success' => false, 'message' => am2_feature_reason\(\$e\)/);
});

test('an unresolved identity is not filed as a missing right', () => {
    const refusal = features.slice(features.indexOf('if (!am2_may_set_feature'),
                                   features.indexOf('if (!am2_may_set_feature') + 1400);
    assert.match(refusal, /\$auth === \[\] \? 'admin-identity-unresolved' : 'admin-lacks-right'/,
        'both failures are logged under one name again');
});

test('the id a failed lookup was made under is named in the log', () => {
    // Without it the distinction above says which kind of failure happened but
    // not what to look at.
    assert.match(apiUsers, /AM2 admin identity unresolved: no admin row for id='\s*\n?\s*\. var_export\(\$admin_id, true\)/,
        'nothing records which id found no administrator');
    assert.match(apiUsers, /\$auth === \[\] && \$admin_role !== 'superadmin'/,
        'a superadmin, whose rights are granted without a lookup, would log a false alarm');
});
