-- 006: one admin row must not be able to take a branch with it.
--
-- On 2026-09-04 at 11:35:58 a single POST to api_admin_panel.php, carrying no
-- session and no key, deleted admin id 4. ON DELETE CASCADE did the rest: 186
-- units, 191 channel memberships, 186 permission rows and 114,514 PTT log rows,
-- in one statement, with no confirmation, no count and no pause. The units kept
-- transmitting on sockets that were still open, and every attempt to log a
-- transmission failed a foreign key for the next three hours.
--
-- The authentication hole that let that POST through is closed. This is the
-- other half, and it is worth closing on its own terms: the same outcome is one
-- misclick away for a legitimate superadmin, and CASCADE gives them no more
-- warning than it gave the attacker.
--
-- Why RESTRICT rather than a soft delete. Soft delete is the textbook answer
-- and the wrong trade here: retrofitting `deleted_at` across the panel's 167
-- raw SQL statements fails *open* when one is missed -- a unit that is deleted
-- but still answers, still signs in, still transmits. RESTRICT fails closed,
-- and it holds regardless of which path tries: the panel, the Admin app, a
-- future Laravel adapter, or psql at two in the morning. It is the database
-- refusing, not an application remembering.
--
-- What this costs: deleting an admin is no longer one statement. It becomes
-- what it always actually was -- move these units to another admin, or delete
-- them deliberately, and only then remove the admin. The panel gains that path
-- separately; without it an operator only sees an unactionable FK error.
--
-- channels.created_by and admin_activity_logs.admin_id keep ON DELETE SET NULL.
-- Losing "who created this channel" is not destructive, and blocking an admin's
-- removal forever because history mentions them would be worse than the gap.
-- The audit trail's own weakness -- that admin_id means the row's owner when a
-- trigger writes it and the acting session when the panel writes it -- is a
-- separate defect and is not papered over here.

-- The constraint is named fk_user_admin, not the users_admin_id_fkey that
-- PostgreSQL would have generated. Writing the guessed name here would have
-- made DROP ... IF EXISTS a silent no-op and then ADD a *second* foreign key
-- beside the original -- two contradictory rules on one column, with the
-- cascade still in place. That is what happened on the first attempt at this
-- file, and it is why the name is taken from the database rather than assumed.
--
-- Re-runnable: dropping by the same name it re-adds means a second run is a
-- no-op rather than a duplicate.
ALTER TABLE public.users
    DROP CONSTRAINT IF EXISTS fk_user_admin;

ALTER TABLE public.users
    ADD CONSTRAINT fk_user_admin
    FOREIGN KEY (admin_id) REFERENCES public.admin(id) ON DELETE RESTRICT;
