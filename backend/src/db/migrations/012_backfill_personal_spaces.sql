-- 012_backfill_personal_spaces.sql — give every existing user a personal
-- namespace (uid === user uid, is_personal = TRUE) so /{username} resolves to
-- a GitHub-style profile immediately, even for accounts created before 011.
-- Idempotent; safe to re-run.

INSERT INTO spaces (uid, description, is_public, is_personal, created_by, created, updated)
SELECT u.uid, '', TRUE, TRUE, u.uid, u.created, u.updated
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE lower(s.uid) = lower(u.uid));

-- A matching organization name is not evidence of ownership. Only provision
-- membership for the user's own personal namespace, never an existing org.
INSERT INTO space_members (space_uid, user_uid, role, created)
SELECT s.uid, u.uid, 'owner', u.created
FROM users u
JOIN spaces s ON s.uid = u.uid AND s.is_personal = TRUE AND s.created_by = u.uid
WHERE NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_uid = s.uid AND m.user_uid = u.uid);
