-- 015_org_roles.sql — normalize org membership roles (owner | admin | member)
-- and guarantee every organization has at least one owner.

UPDATE space_members
SET role = 'member'
WHERE role IS NULL OR role NOT IN ('owner', 'admin', 'member');

-- Spaces whose creator is still a member but nobody is owner: promote the creator.
UPDATE space_members sm
SET role = 'owner'
FROM spaces s
WHERE sm.space_uid = s.uid
  AND sm.user_uid = s.created_by
  AND NOT EXISTS (
    SELECT 1 FROM space_members x WHERE x.space_uid = s.uid AND x.role = 'owner'
  );

-- Spaces with no owner at all: promote the earliest remaining member.
UPDATE space_members sm
SET role = 'owner'
WHERE (sm.space_uid, sm.created, sm.user_uid) IN (
  SELECT DISTINCT ON (m.space_uid) m.space_uid, m.created, m.user_uid
  FROM space_members m
  WHERE NOT EXISTS (
    SELECT 1 FROM space_members x WHERE x.space_uid = m.space_uid AND x.role = 'owner'
  )
  ORDER BY m.space_uid, m.created ASC, m.user_uid ASC
);
